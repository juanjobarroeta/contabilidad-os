// ─────────────────────────────────────────────────────────────────────────────
// Verificación automática de estados de cuenta.
//
// Un estado se verifica solo cuando TODO lo que exige la verificación manual
// (`verificationErrors`) se cumple con lo que se leyó del original: saldos
// inicial/final y totales de abonos/cargos tomados del TEXTO impreso del PDF
// (no del modelo), movimientos que cuadran al centavo, cobertura del mes
// completo, cuenta y moneda coincidentes, sin filas ni duplicados pendientes.
// Si algo falla, el estado queda en la lista «Estados por revisar» con el
// motivo; nada se fuerza. La atestación registra que fue automática.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { monthBounds } from "./matching";
import { accountReview, executeReview, previewReview, verificationErrors, type ReviewOperation, type ReviewRequest } from "./review";

export const MOTIVO_AUTOMATICO =
  "Verificación automática: saldos y totales impresos en el original coinciden al centavo con los movimientos leídos.";

type Controles = { credits?: number | null; debits?: number | null; creditCount?: number | null; debitCount?: number | null } | null;

export interface DocumentoEstado {
  id: string;
  periodo: string | null;
  periodStart: string | null;
  saldoInicial: unknown;
  saldoFinal: unknown;
  controls: unknown;
}

/** Mes al que pertenece el documento: inicio impreso, si no el periodo detectado. */
export function mesDelDocumento(doc: Pick<DocumentoEstado, "periodo" | "periodStart">): { year: number; month: number } | null {
  const ym = (doc.periodStart ?? doc.periodo ?? "").slice(0, 7);
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return null;
  const year = Number(m[1]), month = Number(m[2]);
  return month >= 1 && month <= 12 ? { year, month } : null;
}

const num = (v: unknown) => (v == null || v === "" ? null : Number(v));

/**
 * La operación de verificación con los valores LEÍDOS del original. Devuelve
 * los motivos si falta algo que la verificación necesita (p. ej. una imagen
 * sin capa de texto no trae los totales impresos).
 */
export function operacionAutomatica(doc: DocumentoEstado, year: number, month: number):
  { op: Extract<ReviewOperation, { type: "verify" }>; motivos: [] } | { op: null; motivos: string[] } {
  const opening = num(doc.saldoInicial), closing = num(doc.saldoFinal);
  const c = (doc.controls ?? null) as Controles;
  const motivos: string[] = [];
  if (opening == null || closing == null || !Number.isFinite(opening) || !Number.isFinite(closing)) motivos.push("No se leyeron los saldos inicial y final del original.");
  if (c?.credits == null || c?.debits == null) motivos.push("No se leyeron del original los totales de abonos y cargos.");
  if (motivos.length) return { op: null, motivos };
  const b = monthBounds(year, month);
  const countsUnavailable = c!.creditCount == null || c!.debitCount == null;
  return {
    motivos: [],
    op: {
      type: "verify", batchId: doc.id, opening: opening!, closing: closing!, credits: Number(c!.credits), debits: Number(c!.debits),
      creditCount: countsUnavailable ? null : c!.creditCount, debitCount: countsUnavailable ? null : c!.debitCount, countsUnavailable,
      periodStart: b.from, periodEnd: b.to, accountConfirmed: true, coverageConfirmed: true, originalReviewed: true, reason: MOTIVO_AUTOMATICO,
    },
  };
}

export interface Diagnostico {
  batchId: string;
  bankAccountId: string;
  periodo: string | null;
  year: number | null;
  month: number | null;
  verificado: boolean;
  listo: boolean;
  motivos: string[];
}

/** ¿Este documento puede verificarse solo? No escribe nada. */
export async function diagnosticarEstado(companyId: string, batchId: string): Promise<Diagnostico> {
  const doc = await prisma.importBatch.findFirst({
    where: { id: batchId, companyId, undoneAt: null },
    select: { id: true, bankAccountId: true, periodo: true, periodStart: true, saldoInicial: true, saldoFinal: true, controls: true, archivoNombre: true },
  });
  if (!doc) throw new Error("Documento no encontrado en esta empresa.");
  const mes = mesDelDocumento(doc);
  const base = { batchId, bankAccountId: doc.bankAccountId, year: mes?.year ?? null, month: mes?.month ?? null,
    periodo: mes ? `${mes.year}-${String(mes.month).padStart(2, "0")}` : null };
  if (!mes) return { ...base, verificado: false, listo: false, motivos: ["No se detectó el mes que cubre el documento."] };
  if (!doc.archivoNombre) return { ...base, verificado: false, listo: false, motivos: ["Falta el archivo original."] };
  const review = await accountReview({ companyId, bankAccountId: doc.bankAccountId, ...mes });
  if (review.verified) return { ...base, verificado: true, listo: false, motivos: [] };
  if (review.closed) return { ...base, verificado: false, listo: false, motivos: ["El periodo está cerrado."] };
  const { op, motivos } = operacionAutomatica(doc, mes.year, mes.month);
  if (!op) return { ...base, verificado: false, listo: false, motivos };
  const errores = verificationErrors(review, op);
  return { ...base, verificado: false, listo: errores.length === 0, motivos: errores };
}

/**
 * Verifica el documento si pasa todos los controles. Nunca lanza por un
 * control que no pasa: lo devuelve como motivo para la lista de revisión.
 */
export async function autoVerificarEstado(companyId: string, batchId: string, userId: string): Promise<Diagnostico> {
  const d = await diagnosticarEstado(companyId, batchId);
  if (!d.listo || d.year == null || d.month == null) return d;
  const doc = await prisma.importBatch.findFirstOrThrow({ where: { id: batchId, companyId },
    select: { id: true, periodo: true, periodStart: true, saldoInicial: true, saldoFinal: true, controls: true } });
  const { op } = operacionAutomatica(doc, d.year, d.month);
  try {
    const scope = { companyId, bankAccountId: d.bankAccountId, year: d.year, month: d.month };
    const review = await accountReview(scope);
    const request: ReviewRequest = { ...scope, expected: review.hash, operation: op! };
    const preview = await previewReview(request);
    await executeReview({ ...request, effectExpected: preview.effectHash }, userId);
    return { ...d, verificado: true, listo: false, motivos: [] };
  } catch (e) {
    return { ...d, listo: false, motivos: [e instanceof Error ? e.message : "No se pudo verificar."] };
  }
}

/**
 * Estados con original aún sin verificar, de todos los meses y cuentas, con
 * el motivo de cada uno. Acotado: los 24 más recientes.
 */
export async function estadosPorRevisar(companyId: string) {
  const docs = await prisma.importBatch.findMany({
    where: { companyId, undoneAt: null, verifiedAt: null, archivoNombre: { not: null } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 24,
    select: { id: true, archivoNombre: true, createdAt: true, banco: true, bankAccount: { select: { nombre: true, banco: true } } },
  });
  const out = [];
  for (const doc of docs) {
    let d: Diagnostico;
    try { d = await diagnosticarEstado(companyId, doc.id); }
    catch (e) { d = { batchId: doc.id, bankAccountId: "", periodo: null, year: null, month: null, verificado: false, listo: false,
      motivos: [e instanceof Error ? e.message : "No se pudo revisar."] }; }
    if (d.verificado) continue;
    out.push({ ...d, archivoNombre: doc.archivoNombre, cuenta: `${doc.bankAccount.banco} · ${doc.bankAccount.nombre}`, subidoEl: doc.createdAt.toISOString() });
  }
  return out.sort((a, b) => (b.periodo ?? "").localeCompare(a.periodo ?? ""));
}
