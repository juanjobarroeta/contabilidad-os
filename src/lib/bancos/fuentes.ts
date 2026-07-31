/**
 * Exclusividad de fuentes por cuenta bancaria (guardia anti-duplicado).
 *
 * Una cuenta se alimenta de UNA de dos familias de fuentes, nunca de ambas:
 *
 *  - Estados de cuenta (UPLOAD / UPLOAD_PDF / BELVO): la cuenta bancaria
 *    real, fuente de verdad de la conciliación.
 *  - Ingest externo (/api/ingest/external-income, satélites como PADEL o
 *    JCPT): una cuenta puente/caja virtual donde la app empuja cada cobro.
 *
 * Mezclarlas duplica el ingreso: el cobro empujado por la app volvería a
 * entrar como línea del estado de cuenta (además en neto y agrupado por
 * payout, así que la deduplicación automática es imposible). El flujo
 * correcto es: la app empuja a su cuenta puente, los CFDIs se concilian ahí,
 * y el payout que llega a la cuenta real se registra como traspaso.
 */

import { prisma } from "@/lib/prisma";

/** Fuentes de movimientos que provienen de un estado de cuenta real. */
export const FUENTES_ESTADO_DE_CUENTA = ["UPLOAD", "UPLOAD_PDF", "BELVO"] as const;

export const ERROR_CUENTA_PUENTE =
  "Esta cuenta se alimenta de una app externa (cuenta puente): no puede recibir estados de cuenta, " +
  "porque los cobros ya registrados volverían a entrar como líneas del estado y el ingreso se duplicaría. " +
  "Sube el estado de cuenta a la cuenta bancaria real.";

export const ERROR_CUENTA_CON_ESTADOS =
  "Esta cuenta recibe estados de cuenta (es la fuente de verdad de la conciliación): no puede recibir " +
  "ingresos empujados por una app externa, porque el mismo cobro entraría dos veces —una vez empujado y " +
  "otra como línea del estado de cuenta. Usa una cuenta puente dedicada (p. ej. tipo CAJA) para la app.";

/** true si la cuenta ya tiene movimientos empujados por ingest externo. */
export async function cuentaTieneIngestExterno(bankAccountId: string): Promise<boolean> {
  const row = await prisma.bankTransaction.findFirst({
    where: { bankAccountId, externalRef: { not: null } },
    select: { id: true },
  });
  return Boolean(row);
}

/** true si la cuenta ya se alimenta de estados de cuenta (upload/Belvo). */
export async function cuentaTieneEstadosDeCuenta(bankAccountId: string): Promise<boolean> {
  const row = await prisma.bankTransaction.findFirst({
    where: { bankAccountId, source: { in: [...FUENTES_ESTADO_DE_CUENTA] } },
    select: { id: true },
  });
  return Boolean(row);
}
