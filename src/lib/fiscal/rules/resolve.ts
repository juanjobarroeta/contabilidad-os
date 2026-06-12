// ─────────────────────────────────────────────────────────────────────────────
// Resolution: getRule / listRules.
//
// Applicability + vigencia are resolved here, server-side, so no consumer
// re-implements "which version applies". When several rules share a clave, the
// MOST SPECIFIC applicable one wins (a sector rule beats a "*" rule); ties break
// to the latest vigenciaDesde.
// ─────────────────────────────────────────────────────────────────────────────

import { CATALOGO } from "./catalog";
import type { Aplicabilidad, Contexto, FiscalRule, ReglaResuelta, ValorRegla } from "./types";

function dentroDeVigencia(r: FiscalRule, fecha: string): boolean {
  if (fecha < r.vigenciaDesde) return false;
  if (r.vigenciaHasta !== null && fecha > r.vigenciaHasta) return false;
  return true;
}

/**
 * Whether an `aplicabilidad` matches a context. Exported so other consumers
 * (e.g. the auditor's checks) gate on the same régimen × sector × tipoPersona
 * logic as rules do.
 */
export function aplicaAplicabilidad(a: Aplicabilidad, ctx: Contexto): boolean {
  if (a.regimenes !== "*" && !a.regimenes.includes(ctx.regimen)) return false;
  if (a.tipoPersona !== "*" && a.tipoPersona !== ctx.tipoPersona) return false;
  if (a.actividades !== "*" && !a.actividades.some((s) => ctx.actividades.includes(s)))
    return false;
  // State-specific rule: only matches when the context's entidad is known and listed.
  if (a.entidad && a.entidad !== "*") {
    if (!ctx.entidad || !a.entidad.includes(ctx.entidad)) return false;
  }
  return true;
}

function aplica(r: FiscalRule, ctx: Contexto): boolean {
  return aplicaAplicabilidad(r.aplicabilidad, ctx);
}

/** Higher = more specific. Entidad (jurisdiction) outranks sector, then régimen, then persona. */
function especificidad(r: FiscalRule): number {
  let s = 0;
  if (r.aplicabilidad.entidad && r.aplicabilidad.entidad !== "*") s += 8;
  if (r.aplicabilidad.actividades !== "*") s += 4;
  if (r.aplicabilidad.regimenes !== "*") s += 2;
  if (r.aplicabilidad.tipoPersona !== "*") s += 1;
  return s;
}

function masEspecifica(a: FiscalRule, b: FiscalRule): FiscalRule {
  const d = especificidad(b) - especificidad(a);
  if (d > 0) return b;
  if (d < 0) return a;
  return b.vigenciaDesde.localeCompare(a.vigenciaDesde) > 0 ? b : a;
}

/**
 * Resolve a single rule for a company context. Returns the value + its
 * fundamento, or `null` if no rule applies — callers MUST handle null
 * explicitly (never assume a default fiscal value).
 *
 * The generic lets callers assert the value shape, e.g.
 *   getRule<number>("iva.tasa.general", ctx)
 *   getRule<Tabla>("isr.depreciacion.tasas", ctx)
 */
export function getRule<V extends ValorRegla = ValorRegla>(
  clave: string,
  ctx: Contexto,
): ReglaResuelta<V> | null {
  let elegida: FiscalRule | null = null;
  for (const r of CATALOGO) {
    if (r.clave !== clave) continue;
    if (!dentroDeVigencia(r, ctx.fecha)) continue;
    if (!aplica(r, ctx)) continue;
    elegida = elegida === null ? r : masEspecifica(elegida, r);
  }
  if (elegida === null) return null;
  return {
    clave: elegida.clave,
    valor: elegida.valor as V,
    unidad: elegida.unidad,
    fundamento: elegida.fundamento,
    verificado: elegida.verificado,
  };
}

/**
 * All rules applicable to the context, de-duplicated by clave (the most specific
 * version per clave). Optionally filtered by tipo.
 */
export function listRules(ctx: Contexto, filtro?: { tipo?: FiscalRule["tipo"] }): FiscalRule[] {
  const porClave = new Map<string, FiscalRule>();
  for (const r of CATALOGO) {
    if (!dentroDeVigencia(r, ctx.fecha)) continue;
    if (!aplica(r, ctx)) continue;
    if (filtro?.tipo && r.tipo !== filtro.tipo) continue;
    const prev = porClave.get(r.clave);
    porClave.set(r.clave, prev ? masEspecifica(prev, r) : r);
  }
  return [...porClave.values()];
}
