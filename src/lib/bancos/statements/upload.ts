import { extractStatementFromDocument } from "../vision-statement";
import { pdfEstaProtegido, desencriptarPdf } from "../pdf-crypt";
import { persistStatementTransactions, replayStatement, fileFingerprint } from "./ingest";
import { importBankStatement, periodoDe } from "../import";
import { cuentaTieneIngestExterno, ERROR_CUENTA_PUENTE } from "../fuentes";
import { autoVerificarEstado, type Diagnostico } from "./auto-verify";

/** Verificación automática best-effort: un fallo aquí nunca tumba la carga. */
async function verificar(companyId: string, batchId: string, userId: string): Promise<Diagnostico | null> {
  try { return await autoVerificarEstado(companyId, batchId, userId); }
  catch (e) { console.warn("[bancos] auto-verificación falló", { batchId, motivo: e instanceof Error ? e.message : String(e) }); return null; }
}
const textoVerificacion = (v: Diagnostico | null) => !v ? "" : v.verificado ? " Estado verificado automáticamente." :
  v.motivos.length ? " Queda por revisar: " + v.motivos[0] : "";

export async function uploadBankDocument(opts: { companyId: string; bankAccountId: string; userId: string; bytes: Buffer; filename: string; mime: string; password?: string; month?: string }) {
  if (opts.bytes.byteLength > 15 * 1024 * 1024) throw new Error("El archivo excede 15 MB.");
  if (await cuentaTieneIngestExterno(opts.bankAccountId)) throw new Error(ERROR_CUENTA_PUENTE);
  const fileHash = fileFingerprint(opts.bytes);
  const replay = await replayStatement(opts.companyId, opts.bankAccountId, fileHash);
  if (replay) {
    const verificacion = await verificar(opts.companyId, replay.id, opts.userId);
    return { ok: true, imported: 0, skipped: replay.parsedCount, posiblesDuplicados: replay.parsedCount, pending: replay.rows.length,
      batchId: replay.id, periodo: verificacion?.periodo ?? replay.periodo, replay: true, verificacion, descartadas: [],
      message: "El archivo ya está registrado. Se conserva su evidencia y no se crearon copias." + textoVerificacion(verificacion) };
  }
  const mime = opts.mime === "application/pdf" || opts.filename.toLowerCase().endsWith(".pdf") ? "application/pdf" :
    /image\/(jpeg|png|webp)/.test(opts.mime) ? opts.mime as "image/jpeg" | "image/png" | "image/webp" : null;
  if (!mime) return importBankStatement({ companyId: opts.companyId, bankAccountId: opts.bankAccountId, fileContent: opts.bytes.toString("base64"),
    filename: opts.filename, encoding: "base64", mesEsperado: opts.month });
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("Extracción con IA no configurada.");
  let extractionBytes = opts.bytes;
  if (mime === "application/pdf" && pdfEstaProtegido(extractionBytes)) {
    const result = await desencriptarPdf(extractionBytes, opts.password ?? "");
    if (!result.ok) return { ok: false, needsPassword: true, error: "El PDF necesita su contraseña para poder leerlo." };
    extractionBytes = result.pdf;
  }
  const extraction = await extractStatementFromDocument(extractionBytes, mime, { companyId: opts.companyId, subtipo: "bancos.vision_statement" });
  const period = periodoDe(extraction.transactions) ?? extraction.periodoInicio?.slice(0,7) ?? extraction.periodo ?? opts.month;
  const hold = extraction.balanceCheck.cuadra === false || extraction.controles?.cuadra === false;
  const imported = await persistStatementTransactions({ companyId: opts.companyId, bankAccountId: opts.bankAccountId, userId: opts.userId,
    transactions: extraction.transactions, source: "UPLOAD_PDF", banco: extraction.banco, periodo: period,
    saldoInicial: extraction.balanceCheck.saldoInicial, saldoFinal: extraction.balanceCheck.saldoFinal,
    archivo: { bytes: opts.bytes, nombre: opts.filename, mime }, fileHash, holdForReview: hold,
    declaredAccount: extraction.numeroCuenta, declaredCurrency: extraction.moneda, periodStart: extraction.periodoInicio, periodEnd: extraction.periodoFin,
    controls: extraction.controlesDeclarados, warnings: extraction.warnings,
    cuadro: hold ? false : extraction.balanceCheck.cuadra ?? extraction.controles?.cuadra ?? null,
  });
  const verificacion = await verificar(opts.companyId, imported.batchId, opts.userId);
  return { ok: true, ...imported, periodo: period, verificacion, posiblesDuplicados: imported.skipped, descartadas: [], warnings: extraction.warnings,
    detectedBank: extraction.banco, balanceCheck: extraction.balanceCheck, controles: extraction.controles,
    message: "Documento conservado: " + imported.imported + " movimientos provisionales, " + imported.skipped + " vinculados y " + imported.pending + " por revisar." + (opts.month && period && period !== opts.month ? " El documento cubre " + period + "; cambia al periodo correspondiente." : "") + textoVerificacion(verificacion) };
}
