/** Shared text/Excel parser. Every import retains source evidence; only compatible
 * bank identifiers link automatically. Ambiguous overlaps enter statement review. */
import * as XLSX from "xlsx";
import { parseStatement, type ParseResult, type RowDescartada } from "@/lib/bank-parser";
import { cuentaTieneIngestExterno, ERROR_CUENTA_PUENTE } from "@/lib/bancos/fuentes";
import { decodificarEstadoDeCuenta, esExcelBinario } from "@/lib/bancos/decodificar";

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
  /** Periodo que cubre el archivo ("2026-08", o "2026-08-26 – 2026-09-01"). */
  periodo?: string | null;
  warnings?: string[];
  message: string;
  error?: string;
  batchId?: string | null;
  pending?: number;
};

/**
 * Periodo que cubren los movimientos de un archivo: el mes (AAAA-MM) cuando
 * todos caen en uno, o el rango de fechas cuando lo cruzan. Va al ImportBatch
 * para que "deshacer una importación" muestre QUÉ archivo era — antes el
 * lote de CSV/pegado se guardaba sin banco ni periodo y un estado de Banorte
 * subido a la cuenta de Scotiabank era imposible de distinguir.
 */
export function periodoDe(transactions: { fecha: Date }[]): string | null {
  if (transactions.length === 0) return null;
  const dias = transactions
    .map((t) => t.fecha.toISOString().slice(0, 10))
    .sort();
  const min = dias[0];
  const max = dias[dias.length - 1];
  return min.slice(0, 7) === max.slice(0, 7) ? min.slice(0, 7) : `${min} – ${max}`;
}

/**
 * Persist already-parsed transactions: dedup + auto-categorize + insert.
 * Shared by the text-format importer (parseStatement) and the vision/PDF
 * importer, so dedup and categorization behave identically regardless of how
 * the transactions were parsed. `source` distinguishes provenance.
 */
export { persistStatementTransactions as persistTransactions } from "./statements/ingest";
import { persistStatementTransactions as persistTransactions } from "./statements/ingest";

/**
 * Normaliza (Excel/SpreadsheetML → texto) y parsea un archivo de estado de
 * cuenta SIN persistir nada. Hook aditivo: lo usa importBankStatement (abajo)
 * y el flujo de WhatsApp cuando la empresa tiene varias cuentas bancarias y
 * hay que preguntar a cuál pertenece el archivo ANTES de importar — las filas
 * parseadas se guardan en el pendingAction; el original se conserva aparte.
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

  // El front manda BYTES (base64) para todo. Se decide por FIRMA, no por la
  // extensión: los exports .xls de BBVA ("RSM"/Banca Net Cash) son XML, y hay
  // CSV que llegan con nombre .xls. Mandar un CSV a SheetJS lo re-emite con la
  // idea que SheetJS tenga de la codificación — otra fuente de acentos rotos.
  let content = fileContent;
  let parseName = filename ?? "statement.csv";

  if (encoding === "base64") {
    const buf = Buffer.from(fileContent, "base64");

    if (esExcelBinario(buf)) {
      try {
        const wb = XLSX.read(buf, { type: "buffer" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        if (!ws) throw new Error("sin hojas");
        content = XLSX.utils.sheet_to_csv(ws);
        parseName = parseName.replace(/\.(xlsx|xls|xlsm)$/i, ".csv");
      } catch {
        return { ok: false, error: "Excel ilegible" };
      }
    } else {
      // Texto: CSV, OFX, movimientos pegados o SpreadsheetML. La decodificación
      // detecta Windows-1252 y salva los acentos. SpreadsheetML pasa CRUDO —
      // por SheetJS las fechas ISO (2026-06-30) se reformatean a M/D/YY, que el
      // parser de fechas NO reconoce, y salen 0 movimientos.
      content = decodificarEstadoDeCuenta(buf).texto;
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
  /** Mes que el contador está trabajando ("2026-08"), para avisar si no cuadra. */
  mesEsperado?: string | null;
}): Promise<ImportResult> {
  const { bankAccountId, companyId, fileContent, filename, encoding, mesEsperado } = opts;

  // Guardia anti-duplicado: una cuenta puente (alimentada por ingest externo)
  // nunca recibe estados de cuenta. Ver src/lib/bancos/fuentes.ts.
  if (await cuentaTieneIngestExterno(bankAccountId)) {
    return {
      ok: false,
      imported: 0,
      skipped: 0,
      posiblesDuplicados: 0,
      descartadas: [],
      message: ERROR_CUENTA_PUENTE,
      error: ERROR_CUENTA_PUENTE,
    };
  }

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

  // Banco detectado y periodo van al lote: es lo que vuelve reconocible una
  // importación en "deshacer" (los caminos de PDF y WhatsApp ya lo hacían).
  const periodo = periodoDe(parseResult.transactions);
  const { imported, skipped, pending, batchId } = await persistTransactions({
    bankAccountId,
    companyId,
    transactions: parseResult.transactions,
    archivo: { bytes: Buffer.from(fileContent, encoding === "base64" ? "base64" : "utf8"), nombre: filename, mime: "application/octet-stream" },
    warnings: [...parseResult.warnings, ...parseResult.descartadas.map((r) => "Fila " + r.fila + ": " + r.motivo)],
    source: "UPLOAD",
    banco: parseResult.detectedBank ?? null,
    periodo,
  });

  // EL ARCHIVO DE OTRO MES. Pasó en producción: el contador subió el estado de
  // julio mientras trabajaba agosto, y la cuenta quedó «sin estado de cuenta
  // del mes» sin que nada lo dijera — el archivo entró bien, sólo que era el
  // que no era. El importador ya sabe qué periodo cubre; sólo faltaba comparar.
  const warnings = [...(parseResult.warnings ?? [])];
  if (mesEsperado && periodo && !periodo.startsWith(mesEsperado)) {
    warnings.push(
      `El archivo cubre ${periodo} y estás trabajando ${mesEsperado}. Si querías subir el estado de cuenta de ${mesEsperado}, éste es otro.`,
    );
  }

  const descartadas = parseResult.descartadas;
  return {
    ok: true,
    imported,
    skipped,
    pending,
    batchId,
    posiblesDuplicados: skipped,
    descartadas,
    format: parseResult.format,
    detectedBank: parseResult.detectedBank,
    periodo,
    warnings,
    message:
      `${imported} movimiento(s) importados` +
      `${skipped > 0 ? `, ${skipped} vinculados a operaciones existentes` : ""}` +
      `${pending > 0 ? `, ${pending} por revisar en Estados de cuenta` : ""}` +
      `${descartadas.length > 0 ? `, ${descartadas.length} fila(s) descartadas` : ""}.`,
  };
}
