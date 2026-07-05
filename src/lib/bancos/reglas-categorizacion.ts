// ─────────────────────────────────────────────────────────────────────────────
// Reglas de categorización persistidas + categorización en lote
//
// Da memoria a la categorización de movimientos bancarios SIN CFDI. Hoy
// categorizar uno nunca se recuerda; aquí una regla `CategorizationRule` guarda
// el patrón + la familia que el usuario eligió y se re-aplica:
//
//   1. al importar un nuevo estado de cuenta (ver persistTransactions), y
//   2. de forma RETROACTIVA sobre los movimientos existentes sin conciliar
//      (el "categorizar todos los similares" que limpia la bandeja de una vez).
//
// La escritura al ledger SIEMPRE pasa por `aprobarSugerencia` (idempotente, con
// la etiqueta de familia en `notes` que lee el cierre mensual), para que las dos
// superficies —app y WhatsApp— converjan exactamente en el mismo asiento.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { aprobarSugerencia } from "./sugerencias-concepto";
import {
  FAMILIA_META,
  type CompanyRule,
  type FamiliaConcepto,
  type SignoMovimiento,
} from "./categorizar-concepto";

/** Tipos de match soportados por una regla persistida. */
export type MatchType = "CONTAINS" | "EXACT" | "STARTS_WITH";

/**
 * Carga las reglas de categorización de la empresa como `CompanyRule[]` listas
 * para el matcher puro. Por defecto sólo trae las ACTIVAS y confirmadas por el
 * usuario (origen USER) — que son las que pueden auto-aplicarse al importar.
 */
export async function cargarReglasEmpresa(
  companyId: string,
  opts: { soloUser?: boolean } = { soloUser: true },
): Promise<CompanyRule[]> {
  const rows = await prisma.categorizationRule.findMany({
    where: {
      companyId,
      activo: true,
      ...(opts.soloUser === false ? {} : { origen: "USER" }),
    },
    select: { pattern: true, matchType: true, familia: true, signo: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    pattern: r.pattern,
    matchType: r.matchType,
    familia: r.familia as FamiliaConcepto,
    signo: (r.signo as SignoMovimiento | null) ?? undefined,
  }));
}

// Palabras "ruido" de los estados de cuenta que NO distinguen a un comercio: no
// sirven como token de una regla (matchearían casi todo). Ya normalizadas.
const STOPWORDS = new Set([
  "SPEI", "PAGO", "PAGOS", "COMPRA", "CARGO", "ABONO", "TARJETA", "DEBITO",
  "CREDITO", "TRANSFERENCIA", "TRASPASO", "REFERENCIA", "REF", "FOLIO", "CLABE",
  "CUENTA", "BANCO", "COM", "SA", "CV", "SAPI", "DE", "DEL", "LA", "EL", "LOS",
  "LAS", "POR", "CON", "SIN", "MXN", "USD", "OPERACION", "AUT", "MEXICO",
  "MEX", "SUC", "TDD", "TDC", "INT", "INTERBANCARIA", "ENVIADO", "RECIBIDO",
  "NACIONAL", "NEGOCIO", "DIGITAL", "ONLINE", "WWW", "COMISION",
]);

/**
 * Extrae un token distintivo de la descripción de un movimiento para proponerlo
 * como patrón de una regla. Heurística: el token alfabético (≥3 letras, sin
 * ruido bancario) más largo. Devuelve el token normalizado en MAYÚSCULAS (sin
 * acentos), o "" si no encuentra ninguno bueno. El usuario puede editarlo.
 */
export function extraerTokenConcepto(descripcion: string): string {
  if (!descripcion) return "";
  const norm = descripcion
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
  const tokens = norm
    .split(/[^A-Z]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
  if (tokens.length === 0) return "";
  // El más largo suele ser el nombre del comercio (RAPPI, OPENAI, ANTHROPIC…).
  // A igualdad de longitud, el primero (aparece antes en la descripción).
  return tokens.reduce((mejor, t) => (t.length > mejor.length ? t : mejor), tokens[0]);
}

export interface LoteResult {
  /** Movimientos que quedaron categorizados (nuevos + los que ya lo estaban). */
  aprobados: number;
  /** De esos, cuántos generaron un asiento nuevo en el ledger. */
  creados: number;
  /** Movimientos que no se pudieron categorizar (ya conciliados, periodo cerrado…). */
  errores: number;
}

/**
 * Categoriza en lote una lista de movimientos con la MISMA familia, reusando el
 * `aprobarSugerencia` idempotente uno por uno (nunca duplica asientos). Los
 * fallos individuales no abortan el lote — se cuentan aparte.
 */
export async function aprobarSugerenciasEnLote(
  txIds: string[],
  familia: FamiliaConcepto,
): Promise<LoteResult> {
  const res: LoteResult = { aprobados: 0, creados: 0, errores: 0 };
  for (const txId of txIds) {
    const r = await aprobarSugerencia(txId, familia);
    if (r.ok) {
      res.aprobados++;
      if (r.created) res.creados++;
    } else {
      res.errores++;
    }
  }
  return res;
}

/**
 * Busca los movimientos UNMATCHED SIN CFDI de la empresa cuya descripción
 * contiene el patrón (insensible a mayúsculas). Es la base del conteo de
 * "similares" y del escaneo retroactivo. `signo` (opcional) acota a un tipo.
 */
async function idsSimilaresSinConciliar(
  companyId: string,
  patron: string,
  signo?: SignoMovimiento | null,
): Promise<string[]> {
  if (!patron.trim()) return [];
  const rows = await prisma.bankTransaction.findMany({
    where: {
      companyId,
      status: "UNMATCHED",
      invoiceId: null,
      descripcion: { contains: patron, mode: "insensitive" },
      ...(signo ? { tipo: signo } : {}),
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Cuenta cuántos movimientos sin conciliar empatarían con el patrón. */
export async function contarSimilaresSinConciliar(
  companyId: string,
  patron: string,
  signo?: SignoMovimiento | null,
): Promise<number> {
  if (!patron.trim()) return 0;
  return prisma.bankTransaction.count({
    where: {
      companyId,
      status: "UNMATCHED",
      invoiceId: null,
      descripcion: { contains: patron, mode: "insensitive" },
      ...(signo ? { tipo: signo } : {}),
    },
  });
}

/**
 * Aplica un patrón + familia de forma RETROACTIVA a los movimientos existentes
 * UNMATCHED sin CFDI: los categoriza en lote. Esto es lo que "limpia de una vez"
 * los movimientos recurrentes acumulados (Rappi, OpenAI, …).
 */
export async function aplicarReglaRetroactiva(
  companyId: string,
  patron: string,
  familia: FamiliaConcepto,
  signo?: SignoMovimiento | null,
): Promise<LoteResult> {
  const ids = await idsSimilaresSinConciliar(companyId, patron, signo);
  return aprobarSugerenciasEnLote(ids, familia);
}

/**
 * Upsert de una regla de categorización a partir de un token elegido. No hay
 * índice único (companyId, pattern) — un mismo patrón podría reasignarse a otra
 * familia — así que se busca la primera regla activa con el mismo patrón+signo y
 * se actualiza; si no existe, se crea. Incrementar `hitCount` es responsabilidad
 * de quien aplica la regla (import / retro-scan), no del upsert.
 */
export async function upsertReglaCategorizacion(opts: {
  companyId: string;
  pattern: string;
  familia: FamiliaConcepto;
  signo?: SignoMovimiento | null;
  matchType?: MatchType;
  createdBy?: string | null;
}): Promise<{ id: string; created: boolean }> {
  const pattern = opts.pattern.trim();
  if (!pattern) throw new Error("El patrón de la regla no puede estar vacío");
  if (!FAMILIA_META[opts.familia]) throw new Error(`Familia inválida: ${opts.familia}`);

  const existing = await prisma.categorizationRule.findFirst({
    where: {
      companyId: opts.companyId,
      pattern,
      signo: opts.signo ?? null,
      activo: true,
    },
    select: { id: true },
  });

  if (existing) {
    await prisma.categorizationRule.update({
      where: { id: existing.id },
      data: { familia: opts.familia, matchType: opts.matchType ?? "CONTAINS", origen: "USER" },
    });
    return { id: existing.id, created: false };
  }

  const row = await prisma.categorizationRule.create({
    data: {
      companyId: opts.companyId,
      pattern,
      familia: opts.familia,
      signo: opts.signo ?? null,
      matchType: opts.matchType ?? "CONTAINS",
      origen: "USER",
      createdBy: opts.createdBy ?? null,
    },
    select: { id: true },
  });
  return { id: row.id, created: true };
}
