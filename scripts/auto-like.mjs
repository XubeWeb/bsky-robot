// scripts/auto-like.mjs
// Glue de Node para GitHub Actions: lee los Secrets, arma el cliente de
// Supabase con la service key (salta RLS) y ejecuta cada robot que le toque
// con lib/robot.js — el mismo motor que usa el panel en "modo local"
// (navegador), para que la lógica nunca diverja entre los dos sitios donde
// puede correr.
//
// Entorno (Secrets de GitHub):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_OWNER_ID
//   BSKY_ACCOUNTS  = JSON: [{"handle":"...","appPassword":"..."}]
//   FORCE=true     = ignora la cadencia (botón "Ejecutar ahora")
//   BSKY_SERVICE   = (opcional) https://bsky.social
//   RUN_MINUTES    = (opcional) minutos de trabajo antes de cerrar limpio (8)

import { processBot } from '../lib/robot.js';
import { inActiveWindow } from '../lib/strategy.js';
import { supa } from '../lib/supa.js';

const {
  SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_OWNER_ID,
  BSKY_ACCOUNTS, BSKY_SERVICE, FORCE, RUN_MINUTES,
} = process.env;
const force = String(FORCE).toLowerCase() === 'true';

// Presupuesto de TIEMPO, no solo de likes. Sin esto, un presupuesto grande
// (miles de likes) nunca cabe en un run: GitHub cancela el job al llegar a
// `timeout-minutes` y el robot muere ANTES de su bloque de cierre, así que no
// registra el run ni actualiza next_due_at → queda "le toca" para siempre,
// cada pasada del cron consume el timeout entero y la cuota mensual de Actions
// se agota en días. Parando nosotros un poco antes, el cierre sí se ejecuta.
const RUN_MS = Math.max(1, Number(RUN_MINUTES) || 8) * 60_000;
const startedAt = Date.now();

const log = (...a) => console.log(...a);
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) fail('Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY.');
if (!SUPABASE_OWNER_ID) fail('Falta SUPABASE_OWNER_ID.');

const db = supa(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const accounts = JSON.parse(BSKY_ACCOUNTS || '[]');
const credOf = (handle) => accounts.find((a) => a.handle.replace(/^@/, '').toLowerCase() === handle.replace(/^@/, '').toLowerCase());

(async () => {
  const bots = await db.select('bots', `owner=eq.${SUPABASE_OWNER_ID}&enabled=eq.true&select=*`);
  if (!bots.length) { log('Sin robots habilitados. Nada que hacer.'); return; }

  // los que de verdad van a trabajar, para repartirles el tiempo disponible
  const pending = bots.filter((bot) => {
    const due = force || bot.run_requested_at || !bot.next_due_at || new Date(bot.next_due_at).getTime() <= Date.now();
    if (!due) { log(`⏳ @${bot.handle}: aún no toca.`); return false; }
    if (!credOf(bot.handle)) { log(`⚠️  @${bot.handle}: sin credenciales en BSKY_ACCOUNTS, lo salto.`); return false; }
    return true;
  });

  let any = false;
  for (const [i, bot] of pending.entries()) {
    const left = RUN_MS - (Date.now() - startedAt);
    if (left <= 0) { log(`⌛ @${bot.handle}: sin tiempo en este run, le toca en el siguiente.`); continue; }
    const slice = Math.floor(left / (pending.length - i));   // reparto entre los que faltan
    const deadline = Date.now() + slice;
    any = true;
    try {
      await processBot(bot, { ...credOf(bot.handle), service: BSKY_SERVICE }, db, {
        force, onLog: log,
        // Se para por dos motivos, no por uno: cuando se acaba su rato Y
        // cuando se sale de la ventana horaria.
        //
        // Lo segundo hace falta ahora que las vueltas son largas. La ventana
        // se miraba UNA vez, al empezar, y con vueltas de un cuarto de hora
        // daba igual; con vueltas de cinco horas, una que arrancara a las
        // nueve de la noche seguiria dando likes a las dos de la manana.
        shouldStop: () => Date.now() >= deadline
          || !inActiveWindow(Date.now(), bot.active_hour_start,
                             bot.active_hour_end, bot.tz_offset_min),
      });
    } catch (e) { log(`❌ @${bot.handle}: ${e.message}`); }
  }
  if (!any) log('Ningún robot tocaba esta vez.');
})().catch((e) => fail(e.message));
