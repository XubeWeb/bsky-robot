// lib/robot.js
// MOTOR compartido: procesa UN robot (cuenta) sobre sus objetivos aplicando
// la estrategia (relevancia, saltar muertos/bots/ya-te-siguen, viewer.like,
// presupuesto con warm-up, ventana horaria, tope diario). Lo usan tanto el
// script de Node (scripts/auto-like.mjs, vía GitHub Actions) como el panel
// (app.js, "modo local" en el navegador) — misma lógica en los dos sitios
// donde puede correr, para que nunca diverjan en comportamiento ni en los
// límites de seguridad.
//
// `db` ya viene con los permisos adecuados desde quien llama: service key en
// Node (salta RLS), o la sesión del usuario logueado en el navegador (RLS
// deja escribir lo suyo en ambos casos, ver supabase/schema.sql).

import {
  createSession, refreshSession, getFollowersPage, getProfilesAuth,
  getRecentOwnPostAuth, likePost, followAccount, iterateFollowers, getProfile,
} from './bsky.js';
import { matchesAnyKeyword, warmupBudget, pickBudget, inActiveWindow, nextDueMs } from './strategy.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

// Límites del "día" del robot en SU zona horaria (tz_offset_min), no en UTC del
// servidor. Sin esto, "likes hoy" podía no coincidir con lo que ve el usuario.
function localDayBounds(tzOffsetMin) {
  const offsetMs = (tzOffsetMin || 0) * 60000;
  const shifted = new Date(Date.now() + offsetMs);
  const y = shifted.getUTCFullYear(), m = shifted.getUTCMonth(), d = shifted.getUTCDate();
  const startUTC = new Date(Date.UTC(y, m, d) - offsetMs);
  const endUTC = new Date(startUTC.getTime() + 86400000);
  const day = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { day, startISO: startUTC.toISOString(), endISO: endUTC.toISOString() };
}

// sesión por robot, con auto-refresco
function makeSession(initial) {
  let s = initial;
  const withRefresh = async (fn) => {
    try { return await fn(s); }
    catch (e) { if (/expired|token|auth|jwt/i.test(e.message)) { s = await refreshSession(s); return fn(s); } throw e; }
  };
  return {
    get current() { return s; },
    profiles: (actors) => withRefresh((ss) => getProfilesAuth(ss, actors)),
    post: (did, handle) => withRefresh((ss) => getRecentOwnPostAuth(ss, did, handle)),
    like: (p) => withRefresh((ss) => likePost(ss, p)),
    follow: (did) => withRefresh((ss) => followAccount(ss, did)),
  };
}

// Procesa un robot de principio a fin. `cred` = { handle, appPassword, service? }.
// `opts.shouldStop()` permite cancelar desde una UI (modo local en el navegador);
// se comprueba en los mismos puntos donde ya se corta por presupuesto.
export async function processBot(bot, cred, db, { force = false, onLog = () => {}, shouldStop = () => false } = {}) {
  const log = onLog;

  // ventana horaria
  if (!inActiveWindow(Date.now(), bot.active_hour_start, bot.active_hour_end, bot.tz_offset_min)) {
    log(`🌙 @${bot.handle}: fuera de la ventana horaria. Salto.`);
    return null;
  }

  log(`🔑 @${bot.handle}: iniciando sesión…`);
  const session = makeSession(await createSession({ identifier: cred.handle, password: cred.appPassword, service: cred.service }));

  // 'like' (por defecto) = da like a un post reciente; 'follow' = sigue a la
  // cuenta directamente. Mismo motor de objetivos/filtros, distinta acción
  // final y distinta tabla de memoria (para no mezclar analítica de una con
  // la otra).
  const mode = bot.action_mode === 'follow' ? 'follow' : 'like';
  const table = mode === 'follow' ? 'follows' : 'likes';

  // presupuesto: warm-up + aleatorio, recortado por tope diario
  const wb = warmupBudget({ min: bot.likes_per_run_min, max: bot.likes_per_run_max }, bot.warmup_days, bot.warmup_start_at);
  let budget = pickBudget(wb.min, wb.max);

  // memoria: dids ya procesados por este robot (+ overlap entre robots)
  const mine = await db.selectAll(table, `bot_id=eq.${bot.id}&select=subject_did,created_at`);
  const likedSet = new Set(mine.map((r) => r.subject_did));
  const today = new Date().toISOString().slice(0, 10);
  const likesToday = mine.filter((r) => (r.created_at || '').slice(0, 10) === today).length;
  if (bot.daily_cap != null) budget = Math.min(budget, Math.max(0, bot.daily_cap - likesToday));

  const overlap = new Set();
  if (bot.no_overlap) {
    const all = await db.selectAll(table, `owner=eq.${bot.owner}&bot_id=neq.${bot.id}&select=subject_did`);
    all.forEach((r) => overlap.add(r.subject_did));
  }

  // exclusiones (globales del owner + de este robot)
  const exc = await db.select('exclusions', `owner=eq.${bot.owner}&or=(bot_id.is.null,bot_id.eq.${bot.id})&select=did,handle`);
  const excDid = new Set(exc.map((e) => e.did).filter(Boolean));
  const excHandle = new Set(exc.map((e) => (e.handle || '').toLowerCase()).filter(Boolean));

  const rules = {
    requireKeyword: bot.require_keyword, keywords: bot.keywords || [],
    skipIfFollows: bot.skip_if_follows, skipDeadDays: bot.skip_dead_days, skipLowQuality: bot.skip_low_quality,
  };

  const run = { liked: 0, already: 0, no_post: 0, skipped_rule: 0, scanned: 0, budget, trigger: force ? 'manual' : 'schedule' };
  const scanStart = Math.max(budget, bot.max_scan_per_run || 400);
  let scanBudget = scanStart;

  const targets = await db.select('targets', `bot_id=eq.${bot.id}&status=eq.active&order=priority.asc&select=*`);
  log(`🎯 @${bot.handle}: ${targets.length} objetivos · presupuesto ${budget} likes · ${bot.dry_run ? 'SIMULACIÓN' : 'EN VIVO'}`);

  for (const t of targets) {
    if (budget <= 0 || scanBudget <= 0 || shouldStop()) break;
    let cursor = t.cursor || undefined;
    let pageErrors = 0;

    outer:
    while (budget > 0 && scanBudget > 0 && !shouldStop()) {
      let page;
      try { page = await getFollowersPage(t.handle, cursor); pageErrors = 0; }
      catch (e) {
        pageErrors++;
        log(`  red (@${t.handle}, intento ${pageErrors}/5): ${e.message}`);
        // Tope de reintentos: sin esto, un error persistente (objetivo suspendido,
        // API caída) reintentaba cada 4s SIN LÍMITE hasta el timeout del job (6h),
        // agotando la cuota mensual de Actions en un solo run (incidente 2026-07-12).
        if (pageErrors >= 5) { log(`  @${t.handle}: demasiados errores seguidos, lo salto por hoy.`); break; }
        await sleep(4000 * pageErrors);
        continue;
      }
      if (!page.followers.length && !page.cursor) { await markDone(t); break; }

      // candidatos nuevos de esta página (saltando ya-procesados/excluidos/solape)
      const fresh = page.followers.filter((f) =>
        !likedSet.has(f.did) && !excDid.has(f.did) && !excHandle.has((f.handle || '').toLowerCase()) &&
        !(bot.no_overlap && overlap.has(f.did)));

      for (const batch of chunk(fresh, 25)) {
        if (budget <= 0 || scanBudget <= 0 || shouldStop()) break outer;
        let profiles = [];
        try { profiles = await session.profiles(batch.map((f) => f.did)); }
        catch (e) { log(`  perfiles: ${e.message}`); continue; }
        const byDid = new Map(profiles.map((p) => [p.did, p]));

        for (const f of batch) {
          if (budget <= 0 || scanBudget <= 0 || shouldStop()) break outer;
          const p = byDid.get(f.did);
          if (!p) continue;
          scanBudget--;
          likedSet.add(f.did); // procesado (no repetir aunque lo saltemos)

          // filtro a nivel de perfil
          if (rules.skipIfFollows && p.viewer?.followedBy) { run.skipped_rule++; continue; }
          if (rules.skipLowQuality && (!p.avatar || (p.postsCount || 0) === 0)) { run.skipped_rule++; continue; }
          if (rules.requireKeyword && !matchesAnyKeyword(p.description || '', rules.keywords)) { run.skipped_rule++; continue; }

          if (mode === 'follow') {
            // seguir directamente: no hace falta que tenga posts propios
            if (p.viewer?.following) { run.already++; continue; }
            if (!bot.dry_run) {
              let uri;
              try { uri = await session.follow(f.did); } catch (e) { log(`  ⚠️ @${f.handle}: ${e.message}`); await sleep(2500); continue; }
              await db.insert('follows', [{
                owner: bot.owner, bot_id: bot.id, target_id: t.id,
                subject_did: f.did, subject_handle: f.handle, follow_uri: uri,
              }], { upsert: true, onConflict: 'bot_id,subject_did' }).catch(() => {});
              t.liked = (t.liked || 0) + 1;
            }
            run.liked++; budget--;
            log(`  ${bot.dry_run ? '🧪 seguiría a' : '➕ ahora sigues a'} @${f.handle}  (quedan ${budget})`);
            if (!bot.dry_run) await sleep(randPause(bot));
            continue;
          }

          // necesita un post propio
          let post;
          try { post = await session.post(f.did, f.handle); } catch { continue; }
          if (!post) { run.no_post++; continue; }
          if (post.viewerLike) { run.already++; continue; }
          if (rules.skipDeadDays > 0 && post.lastPostAt &&
              (Date.now() - new Date(post.lastPostAt).getTime()) / 86400000 > rules.skipDeadDays) { run.skipped_rule++; continue; }

          // ❤️ like (o simulación: decide pero no escribe nada real)
          if (!bot.dry_run) {
            try { await session.like(post); } catch (e) { log(`  ⚠️ @${f.handle}: ${e.message}`); await sleep(2500); continue; }
            await db.insert('likes', [{
              owner: bot.owner, bot_id: bot.id, target_id: t.id,
              subject_did: f.did, subject_handle: f.handle, post_uri: post.uri,
            }], { upsert: true, onConflict: 'bot_id,subject_did' }).catch(() => {});
            t.liked = (t.liked || 0) + 1;
          }
          run.liked++; budget--;
          log(`  ${bot.dry_run ? '🧪 daría like a' : '❤️ like a'} @${f.handle}  (quedan ${budget})`);
          if (!bot.dry_run) await sleep(randPause(bot));
        }
      }
      cursor = page.cursor || undefined;
      if (!bot.dry_run) await db.update('targets', { cursor: page.cursor || null }, `id=eq.${t.id}`).catch(() => {});
      if (!page.cursor) { await markDone(t); break; }
    }
    if (!bot.dry_run) await db.update('targets', { liked: t.liked || 0, handled: likedSet.size }, `id=eq.${t.id}`).catch(() => {});
  }

  // cierre del robot
  run.scanned = scanStart - scanBudget;
  await db.insert('runs', [{ owner: bot.owner, bot_id: bot.id, finished_at: new Date().toISOString(), ...run }]).catch(() => {});
  await db.update('bots', {
    last_run_at: new Date().toISOString(),
    next_due_at: new Date(Date.now() + nextDueMs(bot.interval_minutes, bot.jitter_minutes)).toISOString(),
    run_requested_at: null,
  }, `id=eq.${bot.id}`).catch(() => {});

  log(`📊 @${bot.handle}: ❤️ ${run.liked} · ⏭️ ${run.already} ya · 🚫 ${run.skipped_rule} filtrados · ${run.no_post} sin posts · ${run.scanned} revisados`);

  await snapshotAndFollowback(bot, db, log, table).catch((e) => log('  follow-back/daily: ' + e.message));

  return run;

  function randPause(b) {
    const lo = Math.max(1, b.pause_min_sec), hi = Math.max(lo, b.pause_max_sec);
    return Math.round((lo + Math.random() * (hi - lo)) * 1000);
  }
  async function markDone(tt) { if (bot.dry_run) return; await db.update('targets', { status: 'done', cursor: null }, `id=eq.${tt.id}`).catch(() => {}); }
}

// Foto diaria + comprobación de follow-back (el barrido caro solo cada ~12h).
// "follow_back" en `likes`/`follows` = a esta persona le dimos like (o la
// seguimos) Y ahora nos sigue. Como skip_if_follows salta a quien YA te
// seguía antes de la acción, si aparece aquí es porque empezó a seguirte
// DESPUÉS (no es casualidad de que también siga a la cuenta objetivo: eso no
// se mira para nada). `table` = 'likes' o 'follows' según bot.action_mode.
async function snapshotAndFollowback(bot, db, log, table) {
  const dueFb = !bot.last_followback_at || (Date.now() - new Date(bot.last_followback_at).getTime()) > 12 * 3600 * 1000;

  // El NÚMERO de seguidores sale siempre del perfil, nunca de contar la
  // paginación. Antes, los días que tocaba comprobar follow-backs se guardaba
  // dids.length, y ese recuento no cuadra con el del perfil: la paginación se
  // deja por el camino cuentas desactivadas, bloqueadas o suspendidas. El
  // resultado era que en la gráfica aparecía un bache de varios cientos de
  // seguidores justo los días de la comprobación, y el bache no era real.
  //
  // La lista paginada se sigue usando para lo suyo: cruzar quién te sigue
  // ahora con a quién diste like. Para eso vale, porque es una pertenencia
  // ("¿está este DID?"), no un recuento.
  let followersCount = bot.followers_count ?? null;
  try { const p = await getProfile(bot.handle); if (p) followersCount = p.followersCount; }
  catch { /* si falla, se queda el último que había: mejor viejo que inventado */ }

  let followerSet = null;
  if (dueFb) {
    // Si la paginación se corta a medias (red), NO la usamos: mejor esperar al
    // próximo ciclo que resetear follow-backs reales a "false" por datos incompletos.
    const dids = [];
    let complete = false;
    try { for await (const f of iterateFollowers(bot.handle)) dids.push(f.did); complete = true; }
    catch (e) { log(`  seguidores incompletos (${e.message}), no toco follow-back este ciclo`); }
    if (complete) followerSet = new Set(dids);
  }
  if (followersCount != null) {
    await db.update('bots', { followers_count: followersCount, followers_count_at: new Date().toISOString() }, `id=eq.${bot.id}`).catch(() => {});
  }

  let followBacks = null; // null = no se ha comprobado en este ciclo, no tocar bot_daily.follow_backs
  if (followerSet) {
    const mine = await db.selectAll(table, `bot_id=eq.${bot.id}&select=id,subject_did`);
    const back = mine.filter((l) => followerSet.has(l.subject_did)).map((l) => l.id);
    followBacks = back.length;
    await db.update(table, { followed_back: false, followed_back_checked_at: new Date().toISOString() }, `bot_id=eq.${bot.id}`).catch(() => {});
    for (const ids of chunk(back, 50)) {
      await db.update(table, { followed_back: true }, `bot_id=eq.${bot.id}&id=in.(${ids.join(',')})`).catch(() => {});
    }
    await db.update('bots', { last_followback_at: new Date().toISOString() }, `id=eq.${bot.id}`).catch(() => {});
  }

  // bot_daily.likes_given = recuento REAL de acciones (likes o follows según
  // el modo) en el día local del robot (se recalcula siempre desde la tabla,
  // nunca se acumula a ciegas: así una segunda ejecución el mismo día no
  // puede duplicar ni desincronizarse).
  const { day, startISO, endISO } = localDayBounds(bot.tz_offset_min);
  const todays = await db.select(table, `bot_id=eq.${bot.id}&created_at=gte.${startISO}&created_at=lt.${endISO}&select=id`).catch(() => []);
  const patch = { owner: bot.owner, bot_id: bot.id, day, likes_given: todays.length };
  if (followersCount != null) patch.followers_count = followersCount;
  if (followBacks != null) patch.follow_backs = followBacks;
  await db.insert('bot_daily', [patch], { upsert: true, onConflict: 'bot_id,day' }).catch(() => {});
}
