// ─────────────────────────────────────────────────────────────────────────────
// Multas y cantidades actualizadas del CFF (Anexo 5 RMF) — capa de valores.
//
// Los montos NO se leen en vivo: viven en src/lib/fiscal/datos/multas-cff-<Y>.json,
// generados por `npm run fiscal:valores` a partir del PDF oficial del SAT y
// revisados en PR (misma disciplina que tarifas.ts). El cotejo semanal compara
// el JSON contra la fuente y marca el dataset verificado (CotejoFiscal).
// ─────────────────────────────────────────────────────────────────────────────

import type { MultaFila } from "./fuentes/anexo5";
import { MULTAS_CFF_GENERADAS } from "./datos";

export interface MultaVersionada {
  ejercicio: number;
  vigenciaDesde: string; // ISO, inclusive
  vigenciaHasta: string | null; // ISO, inclusive; null = abierta
  /** Descripción legible de la fuente («Anexo 5 RMF 2026, DOF 28-dic-2025»). */
  fuente: string;
  dof: string | null;
  url: string | null;
  /** True cuando el JSON se generó del PDF oficial (o el cotejo lo confirmó). */
  verificado: boolean;
  filas: MultaFila[];
}

export const MULTAS_CFF: MultaVersionada[] = MULTAS_CFF_GENERADAS;

/** Tabla vigente a la fecha (la de vigencia más reciente que la cubra). */
export function multasVigentes(fecha: string | Date = new Date()): MultaVersionada | null {
  const iso = typeof fecha === "string" ? fecha : fecha.toISOString().slice(0, 10);
  const candidatas = MULTAS_CFF.filter((m) => m.vigenciaDesde <= iso && (m.vigenciaHasta === null || iso <= m.vigenciaHasta));
  if (candidatas.length === 0) return null;
  return candidatas.reduce((best, m) => (m.vigenciaDesde > best.vigenciaDesde ? m : best));
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();

/**
 * Filas del artículo (y opcionalmente fracción / inciso) vigentes a la fecha.
 * Prefiere la sección A (cantidades actualizadas) sobre la B (compilación) cuando
 * ambas traen la misma ubicación.
 */
export function buscarMulta(q: { articulo: string; fraccion?: string | null; inciso?: string | null; fecha?: string | Date }): { tabla: MultaVersionada; filas: MultaFila[] } | null {
  const tabla = multasVigentes(q.fecha);
  if (!tabla) return null;
  const art = norm(q.articulo).replace(/^ART(?:[ÍI]CULO|\.)?\s*/, "");
  let filas = tabla.filas.filter((f) => norm(f.articulo) === art);
  if (q.fraccion) filas = filas.filter((f) => norm(f.fraccion) === norm(q.fraccion));
  if (q.inciso) filas = filas.filter((f) => (f.inciso ?? "").toLowerCase() === q.inciso!.toLowerCase());
  const enA = filas.filter((f) => f.seccion === "A");
  return { tabla, filas: enA.length > 0 ? enA : filas };
}

export function coberturaMultasCFF(): { ejercicio: number; verificado: boolean } | null {
  if (MULTAS_CFF.length === 0) return null;
  const u = MULTAS_CFF.reduce((best, m) => (m.ejercicio > best.ejercicio ? m : best));
  return { ejercicio: u.ejercicio, verificado: u.verificado };
}
