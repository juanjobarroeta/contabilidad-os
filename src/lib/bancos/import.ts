/**
 * Shared bank-statement import logic.
 *
 * Both /api/bancos/[id]/upload (session-cookie auth, contabilidad-os UI)
 * and /api/construccion/bank-accounts/[id]/upload (bearer JWT, bartiz UI)
 * delegate here so the parsing + dedup + auto-categorize behaviour is
 * identical from both surfaces.
 *
 * Dedup key: (bankAccountId, fecha day, monto, descripcion, referencia).
 * Same KEY contabilidad-os has used since the bancos module shipped.
 * Counting rule (ver src/lib/bancos/dedup.ts): por clave, si el archivo trae
 * F ocurrencias y la BD ya tiene D (antes de esta subida), se importan
 * max(0, F − D) y las D primeras se omiten como posibles duplicados. Así,
 * dos cargos idénticos el mismo día dentro de un archivo se importan ambos,
 * y re-subir el mismo archivo sigue siendo un no-op.
 *
 * Auto-categorize on import: bank fees, SAT payments, and internal
 * transfers go straight to IGNORED with a notes tag, so the UNMATCHED
 * inbox stays focused on items that actually need a CFDI/Gasto match.
 */

import { prisma } from "@/lib/prisma";
import * as XLSX from "xlsx";
import { parseStatement, type ParseResult, type ParsedTransaction, type RowDescartada } from "@/lib/bank-parser";
import { autoConciliarEmpresa } from "@/lib/bancos/auto-conciliar";
import { claveDeDuplicado, planImportacion } from "@/lib/bancos/dedup";

export type ImportResult = {
  ok: boolean;
  imported: number;
  /** Alias histórico de posiblesDuplicados (lo consumen bartiz y WhatsApp). */
  skipped: number;
  /** Filas omitidas por coincidir con movimientos ya existentes en la BD. */
  posiblesDuplicados: number;
  /** Filas del archivo que el parser no pudo convertir en movimientos. */
  descartadas: RowDescartada[];
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

  // Regla de conteo por clave (día + monto + descripción + referencia):
  // D = movimientos que YA existían en la BD para esa clave (medido ANTES de
  // insertar nada de este archivo — por eso se cachea el conteo la primera
  // vez que vemos la clave, para que nuestras propias inserciones no lo
  // inflen), F = ocurrencias en el archivo. Se importan max(0, F − D) y las
  // D primeras ocurrencias se omiten como posibles duplicados. Ver
  // src/lib/bancos/dedup.ts para la justificación (dos cargos idénticos el
  // mismo día son casi siempre transacciones reales distintas).
  const conteoEnBD = new Map<string, number>();
  const claves: string[] = [];
  for (const tx of transactions) {
    const clave = claveDeDuplicado(tx);
    claves.push(clave);
    if (!conteoEnBD.has(clave)) {
      const fechaStart = new Date(tx.fecha);
      fechaStart.setHours(0, 0, 0, 0);
      const fechaEnd = new Date(tx.fecha);
      fechaEnd.setHours(23, 59, 59, 999);
      const d = await prisma.bankTransaction.count({
        where: {
          bankAccountId,
          fecha: { gte: fechaStart, lte: fechaEnd },
          monto: tx.monto,
          descripcion: tx.descripcion,
          referencia: tx.referencia ?? null,
        },
      });
      conteoEnBD.set(clave, d);
    }
  }
  const plan = planImportacion(claves, (clave) => conteoEnBD.get(clave) ?? 0);

  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];

    if (!plan[i]) { skipped++; continue; }

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

  // Conciliación event-driven: en cuanto entra un estado de cuenta (subida CSV,
  // PDF/visión, o WhatsApp) corremos la auto-conciliación bancaria de alta
  // confianza para la empresa de inmediato, sin esperar al cron diario. Sólo
  // tiene sentido si realmente importamos movimientos nuevos. Idempotente —
  // sólo toca transacciones UNMATCHED. Best-effort: una falla aquí nunca rompe
  // la importación.
  if (imported > 0) {
    try {
      await autoConciliarEmpresa(companyId);
    } catch (e) {
      console.error(`[bancos/import] auto-conciliar tras importar falló para ${companyId}:`, e);
    }
  }

  return { imported, skipped };
}

/**
 * Normaliza (Excel/SpreadsheetML → texto) y parsea un archivo de estado de
 * cuenta SIN persistir nada. Hook aditivo: lo usa importBankStatement (abajo)
 * y el flujo de WhatsApp cuando la empresa tiene varias cuentas bancarias y
 * hay que preguntar a cuál pertenece el archivo ANTES de importar — las filas
 * parseadas se guardan en el pendingAction de la conversación, nunca el
 * archivo crudo.
 */
export function parseStatementFile(opts: {
  fileContent: string;
  filename?: string;
  // "base64" cuando el archivo es binario (Excel .xlsx/.xls) y se envió
  // codificado; "text" (default) para CSV/TXT/OFX enviados como texto.
  encoding?: "text" | "base64";
}): { ok: true; result: ParseResult } | { ok: false; error: string } {
  const { fileContent, filename, encoding } = opts;

  if (!fileContent) return { ok: false, error: "Archivo vacío" };

  // Excel (.xlsx/.xls/.xlsm): binario, el front lo manda en base64.
  let content = fileContent;
  let parseName = filename ?? "statement.csv";
  const esExcel = encoding === "base64" || /\.(xlsx|xls|xlsm)$/i.test(parseName);
  if (esExcel) {
    const buf = encoding === "base64" ? Buffer.from(fileContent, "base64") : Buffer.from(fileContent, "utf8");

    // OJO: los exports .xls de BBVA ("RSM"/Banca Net Cash) NO son Excel binario —
    // son SpreadsheetML 2003 (XML). Si los pasáramos por SheetJS→CSV, las fechas
    // ISO (2026-06-30) se reformatean a M/D/YY de 2 dígitos (6/30/26), que el
    // parser de fechas NO reconoce → 0 movimientos. Detectamos el XML y lo pasamos
    // CRUDO a parseStatement, que lo enruta a su parser dedicado (parseSpreadsheetML)
    // con las fechas ISO intactas. Sólo el Excel binario REAL pasa por SheetJS.
    const cabecera = buf.subarray(0, 4096).toString("utf8");
    const esSpreadsheetML = /mso-application|urn:schemas-microsoft-com:office:spreadsheet|<Workbook/i.test(cabecera);

    if (esSpreadsheetML) {
      content = buf.toString("utf8"); // parseStatement detecta SpreadsheetML por contenido
    } else {
      try {
        const wb = XLSX.read(buf, { type: "buffer" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        if (!ws) throw new Error("sin hojas");
        content = XLSX.utils.sheet_to_csv(ws);
        parseName = parseName.replace(/\.(xlsx|xls|xlsm)$/i, ".csv");
      } catch {
        return { ok: false, error: "Excel ilegible" };
      }
    }
  }

  return { ok: true, result: parseStatement(content, parseName) };
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

  const parsed = parseStatementFile({ fileContent, filename, encoding });
  if (!parsed.ok) {
    const message =
      parsed.error === "Excel ilegible"
        ? "No se pudo leer el archivo de Excel. Verifica que sea un .xlsx válido."
        : parsed.error;
    return { ok: false, imported: 0, skipped: 0, posiblesDuplicados: 0, descartadas: [], message, error: parsed.error };
  }
  const parseResult = parsed.result;

  if (parseResult.transactions.length === 0) {
    return {
      ok: false,
      imported: 0,
      skipped: 0,
      posiblesDuplicados: 0,
      descartadas: parseResult.descartadas,
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

  const descartadas = parseResult.descartadas;
  return {
    ok: true,
    imported,
    skipped,
    posiblesDuplicados: skipped,
    descartadas,
    format: parseResult.format,
    detectedBank: parseResult.detectedBank,
    warnings: parseResult.warnings,
    message:
      `${imported} movimiento(s) importados` +
      `${skipped > 0 ? `, ${skipped} omitido(s) por parecer duplicados de movimientos ya existentes` : ""}` +
      `${descartadas.length > 0 ? `, ${descartadas.length} fila(s) descartadas` : ""}.`,
  };
}
