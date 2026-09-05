// ─────────────────────────────────────────────────────────────────────────────
// HASH DE EVIDENCIA. Un paso confirmado guarda el hash de los hechos sobre los
// que el contador decidió; si los hechos cambian después (entró un CFDI, se
// conció un movimiento), el hash cambia y el paso vuelve a «revisar». Para que
// eso sea fiable el hash tiene que ser DETERMINISTA: claves ordenadas, números
// a centavos, fechas como ISO date. PURO.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";

function canonico(v: unknown): unknown {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  if (Array.isArray(v)) return v.map(canonico);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.keys(o)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        if (o[k] !== undefined) acc[k] = canonico(o[k]);
        return acc;
      }, {});
  }
  return v;
}

/** JSON canónico (claves ordenadas, centavos, fechas ISO date). */
export function serializarEvidencia(hechos: unknown): string {
  return JSON.stringify(canonico(hechos));
}

/** sha256 hex del JSON canónico. */
export function hashEvidencia(hechos: unknown): string {
  return createHash("sha256").update(serializarEvidencia(hechos)).digest("hex");
}
