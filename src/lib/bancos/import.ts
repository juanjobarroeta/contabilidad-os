/**
 * Shared bank-statement import logic.
 *
 * Both /api/bancos/[id]/upload (session-cookie auth, contabilidad-os UI)
 * and /api/construccion/bank-accounts/[id]/upload (bearer JWT, bartiz UI)
 * delegate here so the parsing + dedup + auto-categorize behaviour is
 * identical from both surfaces.
 *
 * Dedup key: (bankAccountId, fecha day, monto, descripcion, referencia).
 * Same rule contabilidad-os has used since the bancos module shipped —
 * tweaking it here would shift dedup behaviour for old uploads, so be
 * careful.
 *
 * Auto-categorize on import: bank fees, SAT payments, and internal
 * transfers go straight to IGNORED with a notes tag, so the UNMATCHED
 * inbox stays focused on items that actually need a CFDI/Gasto match.
 */

import { prisma } from "@/lib/prisma";
import { parseStatement } from "@/lib/bank-parser";

export type ImportResult = {
  ok: boolean;
  imported: number;
  skipped: number;
  format?: string;
  detectedBank?: string | null;
  warnings?: string[];
  message: string;
  error?: string;
};

export async function importBankStatement(opts: {
  bankAccountId: string;
  companyId: string;
  fileContent: string;
  filename: string;
}): Promise<ImportResult> {
  const { bankAccountId, companyId, fileContent, filename } = opts;

  if (!fileContent) {
    return { ok: false, imported: 0, skipped: 0, message: "Archivo vacío", error: "Archivo vacío" };
  }

  const parseResult = parseStatement(fileContent, filename ?? "statement.csv");

  if (parseResult.transactions.length === 0) {
    return {
      ok: false,
      imported: 0,
      skipped: 0,
      warnings: parseResult.warnings,
      message: "No se encontraron transacciones en el archivo.",
      error: "No se encontraron transacciones en el archivo.",
    };
  }

  let imported = 0;
  let skipped = 0;

  for (const tx of parseResult.transactions) {
    const fechaStart = new Date(tx.fecha);
    fechaStart.setHours(0, 0, 0, 0);
    const fechaEnd = new Date(tx.fecha);
    fechaEnd.setHours(23, 59, 59, 999);

    const exists = await prisma.bankTransaction.findFirst({
      where: {
        bankAccountId,
        fecha: { gte: fechaStart, lte: fechaEnd },
        monto: tx.monto,
        descripcion: tx.descripcion,
        referencia: tx.referencia ?? null,
      },
    });

    if (exists) { skipped++; continue; }

    const desc = tx.descripcion;
    const isBankFee = /comisi[oó]n|iva\s+comisi/i.test(desc);
    const isTaxPayment = /pago\s+de\s+impuestos|^impuesto|recaudaci[oó]n|sat\s|tesofe/i.test(desc);
    const isInternalTransfer = /traspaso\s+(entre|a)\s+cuentas?\s+propias?|transferencia\s+propia/i.test(desc);

    let status: "UNMATCHED" | "IGNORED" = "UNMATCHED";
    let notes: string | null = null;
    if (isBankFee) {
      status = "IGNORED";
      notes = "PENDING_MONTHLY_CFDI";
    } else if (isTaxPayment) {
      status = "IGNORED";
      notes = "TAX_PAYMENT";
    } else if (isInternalTransfer) {
      status = "IGNORED";
      notes = "INTERNAL_TRANSFER";
    }

    await prisma.bankTransaction.create({
      data: {
        companyId,
        bankAccountId,
        fecha: tx.fecha,
        descripcion: tx.descripcion,
        monto: tx.monto,
        saldo: tx.saldo ?? null,
        referencia: tx.referencia ?? null,
        tipo: tx.monto >= 0 ? "CREDITO" : "DEBITO",
        status,
        notes,
        source: "UPLOAD",
      },
    });
    imported++;
  }

  return {
    ok: true,
    imported,
    skipped,
    format: parseResult.format,
    detectedBank: parseResult.detectedBank,
    warnings: parseResult.warnings,
    message: `${imported} movimiento(s) importados${skipped > 0 ? `, ${skipped} ya existían` : ""}.`,
  };
}
