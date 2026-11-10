// lib/supa.js
// Cliente mínimo de Supabase (PostgREST + Auth) sin dependencias.
// Funciona en Node (robot, con service key) y en el navegador (panel, con anon
// key + token de usuario). El robot salta RLS con la service key; el panel
// respeta RLS porque va con el token del usuario logueado.

export function supa(url, apikey, bearer) {
  const rest = url.replace(/\/$/, '') + '/rest/v1';
  const headers = (extra = {}) => ({
    apikey,
    Authorization: 'Bearer ' + (bearer || apikey),
    'Content-Type': 'application/json',
    ...extra,
  });

  async function req(method, path, { body, prefer } = {}) {
    const res = await fetch(rest + path, {
      method,
      headers: headers(prefer ? { Prefer: prefer } : {}),
      body: body != null ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`supabase ${method} ${path} → ${res.status} ${t}`);
    }
    const txt = await res.text();
    return txt ? JSON.parse(txt) : null;
  }

  return {
    // select('bots', 'owner=eq.X&order=priority.asc')
    select: (table, query = '') => req('GET', `/${table}?${query || 'select=*'}`),
    // como select pero pagina hasta traerlo TODO (PostgREST corta a 1000/página)
    async selectAll(table, query = '') {
      const out = []; const page = 1000; let offset = 0;
      for (;;) {
        const rows = await req('GET', `/${table}?${query ? query + '&' : ''}limit=${page}&offset=${offset}`);
        out.push(...(rows || []));
        if (!rows || rows.length < page) break;
        offset += page;
      }
      return out;
    },
    // insert('likes', rows) ; upsert para no duplicar (onConflict)
    insert: (table, rows, { upsert, onConflict } = {}) =>
      req('POST', `/${table}${onConflict ? `?on_conflict=${onConflict}` : ''}`, {
        body: rows,
        prefer: `return=representation${upsert ? ',resolution=merge-duplicates' : ''}`,
      }),
    // update('bots', {enabled:false}, 'id=eq.X')
    update: (table, patch, query) =>
      req('PATCH', `/${table}?${query}`, { body: patch, prefer: 'return=representation' }),
    remove: (table, query) => req('DELETE', `/${table}?${query}`, { prefer: 'return=representation' }),
  };
}

// --- Auth (navegador) -------------------------------------------------------

export async function signInPassword(url, anon, email, password) {
  const res = await fetch(url.replace(/\/$/, '') + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const d = await res.json();
  if (!res.ok) throw new Error(d.error_description || d.msg || 'Login fallido');
  return d; // { access_token, refresh_token, user: { id, email } }
}

export async function refreshToken(url, anon, refresh_token) {
  const res = await fetch(url.replace(/\/$/, '') + '/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    headers: { apikey: anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token }),
  });
  if (!res.ok) throw new Error('refresh fallido');
  return res.json();
}
