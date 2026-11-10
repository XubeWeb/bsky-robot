// lib/strategy.js
// Lógica de decisión del robot, en funciones PURAS (sin red, sin DB) para poder
// testearlas. Deciden A QUIÉN likear: relevancia por palabras, calidad, ventana
// horaria, arranque suave (warm-up) y presupuesto aleatorio.

// minúsculas + sin acentos, para comparar bios sin liarse con tildes/mayúsculas.
export function normalize(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// ¿el texto contiene ALGUNA de las palabras? (lista larga permitida)
export function matchesAnyKeyword(text, keywords) {
  if (!keywords || !keywords.length) return false;
  const hay = normalize(text);
  return keywords.some((k) => {
    const n = normalize(k).trim();
    return n.length > 0 && hay.includes(n);
  });
}

const DAY = 86400000;

// Decisión final sobre un candidato. Devuelve { like, reason }.
//   profile: { description, avatar, postsCount, viewerFollowedBy }
//   post:    { viewerLike, lastPostAt, text } | null
//   rules:   { requireKeyword, keywords, skipIfFollows, skipDeadDays, skipLowQuality }
export function shouldLike({ profile = {}, post = null, rules = {}, now = Date.now() }) {
  if (rules.skipIfFollows && profile.viewerFollowedBy) return { like: false, reason: 'ya-te-sigue' };
  if (rules.skipLowQuality && (!profile.avatar || (profile.postsCount || 0) === 0)) return { like: false, reason: 'baja-calidad' };

  if (rules.requireKeyword) {
    const blob = `${profile.description || ''} \n ${post?.text || ''}`;
    if (!matchesAnyKeyword(blob, rules.keywords)) return { like: false, reason: 'fuera-de-tema' };
  }

  if (!post) return { like: false, reason: 'sin-posts' };
  if (post.viewerLike) return { like: false, reason: 'ya-tenia-like' };

  if (rules.skipDeadDays > 0 && post.lastPostAt) {
    const ageDays = (now - new Date(post.lastPostAt).getTime()) / DAY;
    if (ageDays > rules.skipDeadDays) return { like: false, reason: 'inactivo' };
  }
  return { like: true, reason: 'ok' };
}

// Arranque suave: el robot nuevo da menos likes y sube hasta el 100% en warmupDays.
export function warmupBudget({ min, max }, warmupDays, startAt, now = Date.now()) {
  if (!warmupDays || warmupDays <= 0 || !startAt) return { min, max };
  const dayIndex = Math.floor((now - new Date(startAt).getTime()) / DAY) + 1;
  const factor = Math.max(0.2, Math.min(1, dayIndex / warmupDays));
  return {
    min: Math.max(5, Math.round(min * factor)),
    max: Math.max(Math.max(5, Math.round(min * factor)), Math.round(max * factor)),
  };
}

// ¿Estamos dentro de la ventana horaria del robot? (admite ventanas que cruzan medianoche)
export function inActiveWindow(now, startHour, endHour, tzOffsetMin = 0) {
  if (startHour == null || endHour == null) return true;
  const d = new Date(new Date(now).getTime() + tzOffsetMin * 60000);
  const h = d.getUTCHours();
  if (startHour === endHour) return true;
  return startHour < endHour ? (h >= startHour && h < endHour) : (h >= startHour || h < endHour);
}

// Presupuesto aleatorio de likes para esta pasada (entero inclusivo).
export function pickBudget(min, max) {
  const lo = Math.max(1, Math.min(min, max));
  const hi = Math.max(lo, Math.max(min, max));
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

// Próxima ejecución con jitter: intervalo ± jitter aleatorio (ms desde ahora).
export function nextDueMs(intervalMinutes, jitterMinutes = 0) {
  const next = intervalMinutes + (Math.random() * 2 - 1) * (jitterMinutes || 0);
  return Math.max(1, next) * 60000;
}
