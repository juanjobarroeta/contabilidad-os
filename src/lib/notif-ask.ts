// ─────────────────────────────────────────────────────────────────────────────
// Helper PURO para "el tap de una notificación abre el chat con contexto".
//
// Al notificar, adjuntamos a la URL del deep-link un puntero `?ask=<dedupeKey>`.
// Cuando el usuario abre la notificación (push o inbox) y aterriza en la
// pantalla, un handler global lee ese `ask`, recupera el pendiente y siembra el
// asistente. Estas funciones son puras (sin DB ni window) para poder testearlas.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Anexa `?ask=<encodeURIComponent(dedupeKey)>` a una URL, respetando un query
 * string existente (usa `&`) y un hash (lo reinserta al final).
 *
 *   conParametroAsk("/pendientes", "k")            → "/pendientes?ask=k"
 *   conParametroAsk("/x?a=1", "k")                 → "/x?a=1&ask=k"
 *   conParametroAsk("/x#sec", "k")                 → "/x?ask=k#sec"
 *   conParametroAsk("/x?a=1#sec", "k a")           → "/x?a=1&ask=k%20a#sec"
 */
export function conParametroAsk(url: string, dedupeKey: string): string {
  const ask = `ask=${encodeURIComponent(dedupeKey)}`;
  const hashIndex = url.indexOf("#");
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${ask}${hash}`;
}

/**
 * Lee el valor de `ask` de un query string (p.ej. `location.search`), ya
 * decodificado. Acepta el string con o sin el `?` inicial. Devuelve `null` si
 * no está presente.
 */
export function leerAskParam(search: string): string | null {
  const qs = search.startsWith("?") ? search.slice(1) : search;
  return new URLSearchParams(qs).get("ask");
}
