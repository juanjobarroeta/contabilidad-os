// ─────────────────────────────────────────────────────────────────────────────
// Auditor runner. listChecks(ctx) → the checks that apply to the company;
// auditar(cfdis, ctx) → all Hallazgos. Scheduling (cron/queue) is an Auditor
// concern outside this module — it just calls auditar per company.
// ─────────────────────────────────────────────────────────────────────────────

import { aplicaAplicabilidad, type Contexto } from "../rules";
import { CHECKS } from "./checks";
import type { CfdiNormalizado, FiscalCheck, Hallazgo, Severidad } from "./types";

const ORDEN: Record<Severidad, number> = { error: 0, warn: 1, info: 2 };

/** Checks applicable to the context (same régimen × sector × tipoPersona gate). */
export function listChecks(ctx: Contexto): FiscalCheck[] {
  return CHECKS.filter((c) => aplicaAplicabilidad(c.aplicabilidad, ctx));
}

/** Run every applicable check over the CFDIs; findings sorted by severity. */
export function auditar(cfdis: CfdiNormalizado[], ctx: Contexto): Hallazgo[] {
  const hallazgos = listChecks(ctx).flatMap((c) => c.evaluar(cfdis, ctx));
  return hallazgos.sort((a, b) => ORDEN[a.severidad] - ORDEN[b.severidad]);
}
