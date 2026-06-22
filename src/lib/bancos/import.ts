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
import * as XLSX from "xlsx";
import { parseStatement, type ParsedTransaction } from "@/lib/bank-parser";

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

/**
 * Persist already-parsed transactions: dedup + auto-categorize + insert.
 * Shared by the text-format importer (parseStatement) and the vision/PDF
 * importer, so dedup and categorization behave identically regardless of how
 * the transactions were parsed. `source` distinguishes provenance.
 */
export async function persistTransactions(opts: {
  bankAccountId: string;
  companyId: string;
  transactions: ParsedTransaction[];
  source?: string;
}): Promise<{ imported: number; skipped: number }> {
  const { bankAccountId, companyId, transactions, source = "UPLOAD" } = opts;
  let imported = 0;
  let skipped = 0;

  for (const tx of transactions) {
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
    const isTaxPayment =
      /pago\s+de\s+impuestos|^impuesto|recaudaci[oó]n|\bsat\b|tesofe/i.test(desc);
    const isInternalTransfer = /traspaso\s+(entre|a)\s+cuentas?\s+propias?|transferencia\s+propia/i.test(desc);
    const isBankNoise = /compensaci[oó]n\s+por\s+retraso/i.test(desc) || tx.monto === 0;

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
    } else if (isBankNoise) {
      status = "IGNORED";
      notes = "BANK_NOISE";
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
        source,
      },
    });
    imported++;
  }

  return { imported, skipped };
}

export async function importBankStatement(opts: {
  bankAccountId: string;
  companyId: string;
  fileContent: string;
  filename: string;
  // "base64" cuando el archivo es binario (Excel .xlsx/.xls) y se envió
  // codificado; "text" (default) para CSV/TXT/OFX enviados como texto.
  encoding?: "text" | "base64";
}): Promise<ImportResult> {
  const { bankAccountId, companyId, fileContent, filename, encoding } = opts;

  if (!fileContent) {
    return { ok: false, imported: 0, skipped: 0, message: "Archivo vacío", error: "Archivo vacío" };
  }

  // Excel (.xlsx/.xls/.xlsm): es binario, así que el front lo manda en base64.
  // Lo convertimos a CSV con SheetJS y lo pasamos por el mismo parser (que ya
  // detecta el encabezado aunque no esté en la primera fila).
  let content = fileContent;
  let parseName = filename ?? "statement.csv";
  const esExcel = encoding === "base64" || /\.(xlsx|xls|xlsm)$/i.test(parseName);
  if (esExcel) {
    try {
      const buf = Buffer.from(fileContent, "base64");
      const wb = XLSX.read(buf, { type: "buffer" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      if (!ws) throw new Error("sin hojas");
      content = XLSX.utils.sheet_to_csv(ws);
      parseName = parseName.replace(/\.(xlsx|xls|xlsm)$/i, ".csv");
    } catch {
      return {
        ok: false, imported: 0, skipped: 0,
        message: "No se pudo leer el archivo de Excel. Verifica que sea un .xlsx válido.",
        error: "Excel ilegible",
      };
    }
  }

  const parseResult = parseStatement(content, parseName);

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

  const { imported, skipped } = await persistTransactions({
    bankAccountId,
    companyId,
    transactions: parseResult.transactions,
    source: "UPLOAD",
  });

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
