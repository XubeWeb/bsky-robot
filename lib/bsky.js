// lib/bsky.js
// Núcleo AT Protocol compartido por la web (navegador) y el robot (Node 18+).
// Sin dependencias y sin DOM: solo usa fetch / URL / setTimeout (globales en ambos).

const PUBLIC_API = 'https://public.api.bsky.app/xrpc';
export const DEFAULT_SERVICE = 'https://bsky.social';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch con reintentos automáticos ante rate limit (HTTP 429).
async function xrpc(url, opts = {}, { retries = 5 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      // Error de red transitorio: reintenta unas pocas veces.
      if (attempt < retries) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw e;
    }
    if (res.status === 429 && attempt < retries) {
      const reset = Number(res.headers.get('ratelimit-reset'));
      const retryAfter = Number(res.headers.get('retry-after'));
      let waitMs;
      if (reset) waitMs = Math.max(0, reset * 1000 - Date.now()) + 1000;
      else if (retryAfter) waitMs = retryAfter * 1000;
      else waitMs = (attempt + 1) * 5000;
      await sleep(Math.min(waitMs, 90000));
      continue;
    }
    return res;
  }
}

// --- Sesión -----------------------------------------------------------------

// Inicia sesión con handle + App Password. Devuelve la sesión (incluido el
// endpoint del PDS para escrituras, resuelto desde el didDoc cuando existe).
export async function createSession({ identifier, password, service = DEFAULT_SERVICE }) {
  const res = await xrpc(`${service}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: identifier.replace(/^@/, '').trim(), password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Login fallido (${res.status})`);
  }
  const data = await res.json();
  let pds = service;
  const services = data.didDoc?.service || [];
  const pdsSvc = services.find(
    (s) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer'
  );
  if (pdsSvc?.serviceEndpoint) pds = pdsSvc.serviceEndpoint;
  return {
    did: data.did,
    handle: data.handle,
    accessJwt: data.accessJwt,
    refreshJwt: data.refreshJwt,
    pds,
    service,
  };
}

// Refresca una sesión caducada usando el refreshJwt. Devuelve la sesión
// actualizada (mismos campos, nuevos tokens).
export async function refreshSession(session) {
  const base = session.pds || session.service || DEFAULT_SERVICE;
  const res = await xrpc(`${base}/xrpc/com.atproto.server.refreshSession`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.refreshJwt}` },
  });
  if (!res.ok) throw new Error('Sesión caducada: vuelve a entrar.');
  const d = await res.json();
  return {
    ...session,
    accessJwt: d.accessJwt,
    refreshJwt: d.refreshJwt,
    handle: d.handle || session.handle,
    did: d.did || session.did,
  };
}

// --- Lecturas (API pública, sin auth) ---------------------------------------

// Recorre TODOS los seguidores de una cuenta paginando automáticamente.
export async function* iterateFollowers(actor, { pageSize = 100 } = {}) {
  let cursor;
  do {
    const url = new URL(`${PUBLIC_API}/app.bsky.graph.getFollowers`);
    url.searchParams.set('actor', actor.replace(/^@/, '').trim());
    url.searchParams.set('limit', String(pageSize));
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await xrpc(url.toString());
    if (!res.ok) throw new Error(`getFollowers falló (${res.status}) para ${actor}`);
    const data = await res.json();
    for (const f of data.followers || []) yield f;
    cursor = data.cursor || null;
  } while (cursor);
}

// Devuelve el post propio más reciente de un usuario (ignora reposts y replies),
// o null si no tiene posts visibles.
export async function getRecentOwnPost(did, handle) {
  const url = new URL(`${PUBLIC_API}/app.bsky.feed.getAuthorFeed`);
  url.searchParams.set('actor', handle || did);
  url.searchParams.set('limit', '10');
  url.searchParams.set('filter', 'posts_no_replies');
  const res = await xrpc(url.toString());
  if (!res.ok) return null;
  const data = await res.json();
  const item = (data.feed || []).find((x) => x.post && x.post.author.did === did);
  return item ? { uri: item.post.uri, cid: item.post.cid } : null;
}

// Una página de seguidores (máx. 100). Devuelve { followers, cursor } para
// poder reanudar la paginación más tarde (clave para el motor del monitor).
export async function getFollowersPage(actor, cursor) {
  const url = new URL(`${PUBLIC_API}/app.bsky.graph.getFollowers`);
  url.searchParams.set('actor', actor.replace(/^@/, '').trim());
  url.searchParams.set('limit', '100');
  if (cursor) url.searchParams.set('cursor', cursor);
  const res = await xrpc(url.toString());
  if (!res.ok) throw new Error(`getFollowers falló (${res.status}) para ${actor}`);
  const data = await res.json();
  return { followers: data.followers || [], cursor: data.cursor || null };
}

// Post propio más reciente CON estado del visor (autenticado): incluye
// viewerLike = AT-URI del like si la sesión YA dio like a ese post (o null).
// Esto permite comprobar "¿ya le di like al último tweet?" antes de darlo.
// Se consulta contra el PDS de la sesión, que añade el estado del visor.
export async function getRecentOwnPostAuth(session, did, handle) {
  const base = session.pds || session.service || DEFAULT_SERVICE;
  const url = new URL(`${base}/xrpc/app.bsky.feed.getAuthorFeed`);
  url.searchParams.set('actor', handle || did);
  url.searchParams.set('limit', '10');
  url.searchParams.set('filter', 'posts_no_replies');
  const res = await xrpc(url.toString(), { headers: { Authorization: `Bearer ${session.accessJwt}` } });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.message || `getAuthorFeed ${res.status}`);
  }
  const data = await res.json();
  const item = (data.feed || []).find((x) => x.post && x.post.author.did === did);
  if (!item) return null;
  return {
    uri: item.post.uri,
    cid: item.post.cid,
    viewerLike: item.post.viewer?.like || null,
    lastPostAt: item.post.indexedAt || item.post.record?.createdAt || null,
    text: (item.post.record?.text || '').slice(0, 80),
  };
}

// Perfil único (incluye followersCount, avatar, displayName).
export async function getProfile(actor) {
  const [p] = await getProfiles([actor]);
  return p || null;
}

// Perfiles en lote CON estado del visor (autenticado): incluye
// viewer.followedBy (= ese usuario ya sigue al robot) + description + postsCount.
// Necesario para el filtro de relevancia y para saltar a quien ya te sigue.
export async function getProfilesAuth(session, actors) {
  const base = session.pds || session.service || DEFAULT_SERVICE;
  const url = new URL(`${base}/xrpc/app.bsky.actor.getProfiles`);
  for (const a of actors) url.searchParams.append('actors', a);
  const res = await xrpc(url.toString(), { headers: { Authorization: `Bearer ${session.accessJwt}` } });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.message || `getProfilesAuth ${res.status}`);
  }
  const data = await res.json();
  return data.profiles || [];
}

// Perfiles en lote (máx. 25 por llamada).
export async function getProfiles(actors) {
  const url = new URL(`${PUBLIC_API}/app.bsky.actor.getProfiles`);
  for (const a of actors) url.searchParams.append('actors', a);
  const res = await xrpc(url.toString());
  if (!res.ok) throw new Error(`getProfiles falló (${res.status})`);
  const data = await res.json();
  return data.profiles || [];
}

// --- Escrituras (requieren sesión) ------------------------------------------

// Da like a un post. Devuelve 'liked' o 'already' (si ya existía el like).
export async function likePost(session, { uri, cid }) {
  const res = await xrpc(`${session.pds}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.accessJwt}`,
    },
    body: JSON.stringify({
      repo: session.did,
      collection: 'app.bsky.feed.like',
      record: {
        $type: 'app.bsky.feed.like',
        subject: { uri, cid },
        createdAt: new Date().toISOString(),
      },
    }),
  });
  if (res.ok) return 'liked';
  const err = await res.json().catch(() => ({}));
  if ((err.message || '').toLowerCase().includes('already')) return 'already';
  throw new Error(err.message || `like falló (${res.status})`);
}

// Sigue a una cuenta. Devuelve el AT-URI del registro de follow creado (hace
// falta para poder dejar de seguir más tarde con deleteRecord).
export async function followAccount(session, did) {
  const res = await xrpc(`${session.pds}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.accessJwt}`,
    },
    body: JSON.stringify({
      repo: session.did,
      collection: 'app.bsky.graph.follow',
      record: { $type: 'app.bsky.graph.follow', subject: did, createdAt: new Date().toISOString() },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `follow falló (${res.status})`);
  }
  const data = await res.json();
  return data.uri;
}

// Deja de seguir: borra el registro de follow por su AT-URI
// (at://did/app.bsky.graph.follow/<rkey>).
export async function unfollowAccount(session, followUri) {
  const rkey = followUri.split('/').pop();
  const res = await xrpc(`${session.pds}/xrpc/com.atproto.repo.deleteRecord`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.accessJwt}`,
    },
    body: JSON.stringify({ repo: session.did, collection: 'app.bsky.graph.follow', rkey }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `unfollow falló (${res.status})`);
  }
}

// Recorre TODOS los registros de follow del PROPIO repo (paginado), con su
// AT-URI (para poder borrarlos) y el DID al que apunta cada uno. A diferencia
// de app.bsky.graph.getFollows (que no da el URI del registro), esto usa
// com.atproto.repo.listRecords sobre la colección app.bsky.graph.follow.
export async function* iterateMyFollows(session) {
  let cursor;
  do {
    const url = new URL(`${session.pds}/xrpc/com.atproto.repo.listRecords`);
    url.searchParams.set('repo', session.did);
    url.searchParams.set('collection', 'app.bsky.graph.follow');
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await xrpc(url.toString(), { headers: { Authorization: `Bearer ${session.accessJwt}` } });
    if (!res.ok) throw new Error(`listRecords (follows) falló (${res.status})`);
    const data = await res.json();
    for (const r of data.records || []) yield { uri: r.uri, subjectDid: r.value?.subject };
    cursor = data.cursor || null;
  } while (cursor);
}

// --- Orquestadores de alto nivel --------------------------------------------

// Da like a un post reciente de cada seguidor de `targetHandle`.
// Opciones:
//   delayMs      pausa entre acciones (defecto 700 ms, ~seguro para rate limit)
//   maxLikes     tope de likes nuevos por ejecución (defecto Infinity)
//   skip         Set de DIDs a saltar (ya procesados en ejecuciones previas)
//   shouldStop   () => boolean para cancelar desde la UI
//   onProgress   callback por cada seguidor procesado
export async function likeFollowersOf(session, targetHandle, {
  delayMs = 700,
  maxLikes = Infinity,
  skip = new Set(),
  shouldStop = () => false,
  onProgress = () => {},
} = {}) {
  let liked = 0, skipped = 0, processed = 0;
  for await (const f of iterateFollowers(targetHandle)) {
    if (shouldStop()) break;
    if (liked >= maxLikes) break;
    processed++;
    if (skip.has(f.did)) {
      onProgress({ handle: f.handle, did: f.did, status: 'ya-procesado', liked, skipped, processed });
      continue;
    }
    let status;
    try {
      const post = await getRecentOwnPost(f.did, f.handle);
      if (!post) {
        status = 'sin-posts';
        skipped++;
        skip.add(f.did);
      } else {
        const r = await likePost(session, post);
        status = r === 'liked' ? 'like' : 'ya-tenía-like';
        if (r === 'liked') liked++; else skipped++;
        skip.add(f.did);
      }
    } catch (e) {
      status = 'error: ' + e.message;
      skipped++;
    }
    onProgress({ handle: f.handle, did: f.did, status, liked, skipped, processed });
    if (!shouldStop()) await sleep(delayMs);
  }
  return { liked, skipped, processed };
}

// Lista los seguidores de `targetHandle` con >= minFollowers seguidores.
export async function findBigFollowers(targetHandle, {
  minFollowers = 2000,
  shouldStop = () => false,
  onProgress = () => {},
} = {}) {
  const followers = [];
  for await (const f of iterateFollowers(targetHandle)) {
    if (shouldStop()) break;
    followers.push(f.handle);
    onProgress({ phase: 'recogiendo', total: followers.length });
  }
  const results = [];
  for (let i = 0; i < followers.length; i += 25) {
    if (shouldStop()) break;
    const batch = followers.slice(i, i + 25);
    let profiles = [];
    try {
      profiles = await getProfiles(batch);
    } catch (e) {
      onProgress({ phase: 'error', message: e.message });
      continue;
    }
    for (const p of profiles) {
      if ((p.followersCount || 0) >= minFollowers) {
        results.push({
          handle: p.handle,
          displayName: p.displayName || p.handle,
          followersCount: p.followersCount,
          avatar: p.avatar || '',
        });
      }
    }
    onProgress({
      phase: 'perfiles',
      processed: Math.min(i + 25, followers.length),
      total: followers.length,
      found: results.length,
    });
  }
  results.sort((a, b) => b.followersCount - a.followersCount);
  return results;
}
