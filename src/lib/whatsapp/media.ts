import { prisma } from "@/lib/prisma";
import { extractStatementFromDocument } from "@/lib/bancos/vision-statement";
import { parseStatementFile } from "@/lib/bancos/import";
import { importCfdiFromXml } from "@/lib/facturas/import-cfdi";
import {
  MAX_MEDIA_BYTES,
  decidirIngesta,
  bancosDifieren,
  mensajeConfirmarImportacion,
  mensajeSeleccionCuenta,
  mensajeSinCuentas,
  resolverCuentaDestino,
  serializarMovimientos,
  stagePendingImportEstado,
  etiquetaCuenta,
  ultimos4Digitos,
  type CuentaCandidata,
} from "@/lib/whatsapp/estado-cuenta";

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp inbound media → the right extractor.
//
// - XML → CFDI register (exact).
// - CSV/OFX/Excel → parser de texto existente (sin visión).
// - PDF/imagen → clasifica estado de cuenta vs factura y extrae con visión.
//
// SEGURIDAD: el archivo llega como Buffer en memoria y NUNCA se persiste — de
// aquí sólo salen filas parseadas (importadas o cacheadas en pendingAction).
// La extracción por visión pasa por el CANDADO DE BALANCE (estado-cuenta.ts)
// antes de importar nada. Returns a short Spanish summary to send back to the
// user. Never throws to the caller — always returns a user-facing message.
// ─────────────────────────────────────────────────────────────────────────────

function classifyContentType(
  ct: string,
  filename: string,
  buffer?: Buffer
): "xml" | "pdf" | "image" | "audio" | "statement_text" | "other" {
  const c = ct.toLowerCase();
  const f = filename.toLowerCase();
  if (c.includes("xml") || f.endsWith(".xml")) return "xml";
  if (c.includes("pdf") || f.endsWith(".pdf")) return "pdf";
  if (c.startsWith("image/")) return "image";
  if (c.startsWith("audio/")) return "audio";

  // CSV / Excel / OFX bank statement files. WhatsApp/Twilio often send these as
  // text/csv, application/vnd.ms-excel, or a generic octet-stream — so also
  // sniff the content for OFX tags or comma/semicolon-delimited rows.
  const isCsvLikeType =
    c.includes("csv") ||
    c.includes("excel") ||
    c.includes("spreadsheet") ||
    c.includes("text/plain") ||
    c.includes("officedocument.spreadsheet");
  const isCsvLikeName = /\.(csv|ofx|qfx|xls|xlsx|txt)$/.test(f);
  if (isCsvLikeType || isCsvLikeName) return "statement_text";

  if (buffer && (c.includes("octet-stream") || c === "")) {
    const head = buffer.subarray(0, 2048).toString("utf-8");
    const looksOfx = head.includes("<OFX>") || head.includes("<STMTTRN>");
    const looksCsv = /[^\n]+[;,\t][^\n]+\n[^\n]+[;,\t]/.test(head); // ≥2 delimited rows
    if (looksOfx || looksCsv) return "statement_text";
  }
  return "other";
}

/** Cuentas bancarias candidatas de la empresa, en orden estable. */
async function cuentasDeEmpresa(companyId: string): Promise<CuentaCandidata[]> {
  return prisma.bankAccount.findMany({
    where: { companyId },
    select: { id: true, banco: true, nombre: true, numeroCuenta: true, clabe: true },
    orderBy: { createdAt: "asc" },
  });
}

/** Razón social de la empresa destino (para el mensaje de confirmación). */
async function razonSocialDe(companyId: string): Promise<string> {
  const c = await prisma.company.findUnique({ where: { id: companyId }, select: { razonSocial: true } });
  return c?.razonSocial ?? "tu empresa";
}

/** Etiqueta corta de una cuenta candidata (banco + terminación). */
function etiquetaDe(cuenta: CuentaCandidata): string {
  return etiquetaCuenta(cuenta);
}

/** Firma del extractor por visión — inyectable para tests (extracción falsa). */
export type ExtractorEstadoCuenta = typeof extractStatementFromDocument;

export async function handleWhatsappMedia(opts: {
  companyId: string;
  conversationId: string;
  buffer: Buffer;
  contentType: string;
  filename: string;
  /** Inyección para tests; en producción es la visión real. */
  extractor?: ExtractorEstadoCuenta;
}): Promise<string> {
  const { companyId, conversationId, buffer, contentType, filename } = opts;
  const extractor = opts.extractor ?? extractStatementFromDocument;

  // Tope de tamaño (espeja el límite de 15 MB del upload web).
  if (buffer.length > MAX_MEDIA_BYTES) {
    return (
      "El archivo pesa más de 15 MB y no puedo procesarlo por este medio. " +
      "Envía una versión más ligera (por ejemplo, el CSV del banco) o súbelo desde la aplicación."
    );
  }

  const kind = classifyContentType(contentType, filename, buffer);

  // ── XML → exact CFDI register ─────────────────────────────────────────────
  if (kind === "xml") {
    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { rfc: true } });
    if (!company) return "No encontré la empresa para registrar el CFDI.";
    try {
      const r = await importCfdiFromXml({ companyId, companyRfc: company.rfc, xml: buffer.toString("utf-8") });
      if (!r.ok) return "No pude leer ese XML como CFDI válido.";
      return r.duplicate ? "Ese CFDI ya estaba registrado." : "Listo, registré el CFDI.";
    } catch {
      return "Tuve un problema registrando el CFDI. Inténtalo de nuevo.";
    }
  }

  // ── CSV / Excel / OFX bank statement → exact text parser (sin visión) ─────
  if (kind === "statement_text") {
    return intakeArchivoBanco({ companyId, conversationId, buffer, filename });
  }

  // Audio is handled upstream (transcription) before reaching here.
  if (kind !== "pdf" && kind !== "image") {
    return "No reconozco ese tipo de archivo. Envíame el estado de cuenta en PDF, foto o CSV/Excel del banco, o el XML del CFDI.";
  }

  // ── PDF/image: classify statement vs invoice via vision ───────────────────
  const mediaType =
    kind === "pdf"
      ? ("application/pdf" as const)
      : contentType.includes("png")
      ? ("image/png" as const)
      : contentType.includes("webp")
      ? ("image/webp" as const)
      : ("image/jpeg" as const);

  // The statement extractor returns balances + movimientos; if it finds neither,
  // it's probably an invoice — fall back to the invoice nudge. El costo LLM se
  // atribuye a la empresa (cuenta contra su presupuesto mensual de WhatsApp).
  let extraction;
  try {
    extraction = await extractor(buffer, mediaType, {
      companyId,
      subtipo: "whatsapp.vision_statement",
    });
  } catch {
    return "No pude leer el documento. Envía un archivo más claro o, si es una factura, su XML.";
  }

  // Heuristic: a bank statement has multiple movimientos and/or balances.
  const looksLikeStatement =
    extraction.transactions.length >= 2 ||
    extraction.balanceCheck.saldoInicial != null ||
    extraction.balanceCheck.saldoFinal != null;

  if (!looksLikeStatement) {
    return (
      "Parece una factura, no un estado de cuenta. Para registrarla con exactitud, " +
      "envíame el XML del CFDI (el PDF no es suficiente para uso fiscal)."
    );
  }

  // CANDADO DE BALANCE + resolución de cuenta (lógica pura en estado-cuenta.ts).
  const cuentas = await cuentasDeEmpresa(companyId);
  const decision = decidirIngesta(
    {
      banco: extraction.banco,
      numeroCuenta: extraction.numeroCuenta,
      periodo: extraction.periodo,
      transactions: extraction.transactions,
      saldoInicial: extraction.balanceCheck.saldoInicial,
      saldoFinal: extraction.balanceCheck.saldoFinal,
    },
    cuentas
  );

  switch (decision.accion) {
    case "IMPORTAR": {
      // GUARDARRAÍL: NO se importa a ciegas. Se escenifica y se pide confirmación
      // que nombra empresa + cuenta destino (y advierte si el banco no coincide),
      // para que un estado de cuenta no caiga en la empresa/cuenta equivocada.
      const companyName = await razonSocialDe(companyId);
      const bancoMismatch = bancosDifieren(extraction.banco, decision.cuenta.banco);
      await stagePendingImportEstado(conversationId, {
        companyId,
        companyName,
        origen: "vision",
        banco: extraction.banco,
        periodo: extraction.periodo,
        saldoVerificado: true,
        movimientos: serializarMovimientos(extraction.transactions),
        descartadas: [],
        cuentas: [
          {
            id: decision.cuenta.id,
            etiqueta: etiquetaDe(decision.cuenta),
            terminacion: ultimos4Digitos(decision.cuenta.numeroCuenta) ?? ultimos4Digitos(decision.cuenta.clabe),
          },
        ],
        defaultCuentaId: decision.cuenta.id,
        bancoMismatch,
      });
      return mensajeConfirmarImportacion({
        companyName,
        cuentaEtiqueta: etiquetaDe(decision.cuenta),
        bancoDetectado: extraction.banco,
        movimientos: extraction.transactions.length,
        bancoMismatch,
      });
    }
    case "ELEGIR_CUENTA": {
      // Cacheamos las filas parseadas (no el archivo) hasta que elija cuenta.
      const companyName = await razonSocialDe(companyId);
      await stagePendingImportEstado(conversationId, {
        companyId,
        companyName,
        origen: "vision",
        banco: extraction.banco,
        periodo: extraction.periodo,
        saldoVerificado: true,
        movimientos: serializarMovimientos(extraction.transactions),
        descartadas: [],
        cuentas: decision.cuentas.map((c) => ({
          id: c.id,
          etiqueta: etiquetaCuenta(c),
          terminacion: ultimos4Digitos(c.numeroCuenta) ?? ultimos4Digitos(c.clabe),
        })),
        defaultCuentaId: null,
        bancoMismatch: false,
      });
      return `Para *${companyName}*: ${decision.mensaje}`;
    }
    default:
      // SIN_MOVIMIENTOS / BALANCE_NO_VERIFICABLE / BALANCE_NO_CUADRA / SIN_CUENTAS:
      // no se importa nada; el mensaje explica el motivo.
      return decision.mensaje;
  }
}

/** Intake de CSV/OFX/Excel: parsea con el parser exacto (sin visión ni candado
 *  de saldos — el archivo del banco es la fuente de verdad) y resuelve cuenta. */
async function intakeArchivoBanco(opts: {
  companyId: string;
  conversationId: string;
  buffer: Buffer;
  filename: string;
}): Promise<string> {
  const { companyId, conversationId, buffer, filename } = opts;

  // Excel binario real (xlsx = zip "PK..", xls = contenedor OLE): hay que
  // pasarlo en base64 para que parseStatementFile lo lea con SheetJS en vez
  // de corromperlo como UTF-8.
  const cabeza = buffer.subarray(0, 4);
  const esExcelBinario =
    cabeza.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ||
    cabeza.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));

  const parsed = parseStatementFile(
    esExcelBinario
      ? { fileContent: buffer.toString("base64"), filename: filename || "estado.xlsx", encoding: "base64" }
      : { fileContent: buffer.toString("utf-8"), filename: filename || "estado.csv" }
  );

  if (!parsed.ok) {
    return `No pude leer ese archivo de movimientos: ${parsed.error}. Si es Excel, expórtalo a CSV e inténtalo de nuevo.`;
  }
  const r = parsed.result;
  if (r.transactions.length === 0) {
    return "No encontré movimientos en el archivo. Verifica que sea el estado de cuenta del banco (CSV, OFX o Excel) e inténtalo de nuevo.";
  }

  const cuentas = await cuentasDeEmpresa(companyId);
  const resolucion = resolverCuentaDestino(cuentas, null);

  if (resolucion.tipo === "NINGUNA") return mensajeSinCuentas();

  const companyName = await razonSocialDe(companyId);

  if (resolucion.tipo === "VARIAS") {
    await stagePendingImportEstado(conversationId, {
      companyId,
      companyName,
      origen: "archivo",
      banco: r.detectedBank ?? null,
      periodo: null,
      saldoVerificado: false,
      movimientos: serializarMovimientos(r.transactions),
      descartadas: r.descartadas,
      cuentas: resolucion.cuentas.map((c) => ({
        id: c.id,
        etiqueta: etiquetaCuenta(c),
        terminacion: ultimos4Digitos(c.numeroCuenta) ?? ultimos4Digitos(c.clabe),
      })),
      defaultCuentaId: null,
      bancoMismatch: false,
    });
    return `Para *${companyName}*: ${mensajeSeleccionCuenta(resolucion.cuentas, {
      banco: r.detectedBank ?? null,
      movimientos: r.transactions.length,
    })}`;
  }

  // UNICA. Antes se importaba DIRECTO — ese fue el hoyo: un estado de cuenta de
  // otro banco caía en la única cuenta sin confirmar. Ahora se escenifica y se
  // pide confirmación nombrando empresa + cuenta, con aviso si el banco difiere.
  const cuenta = resolucion.cuenta;
  const bancoMismatch = bancosDifieren(r.detectedBank ?? null, cuenta.banco);
  await stagePendingImportEstado(conversationId, {
    companyId,
    companyName,
    origen: "archivo",
    banco: r.detectedBank ?? null,
    periodo: null,
    saldoVerificado: false,
    movimientos: serializarMovimientos(r.transactions),
    descartadas: r.descartadas,
    cuentas: [
      {
        id: cuenta.id,
        etiqueta: etiquetaDe(cuenta),
        terminacion: ultimos4Digitos(cuenta.numeroCuenta) ?? ultimos4Digitos(cuenta.clabe),
      },
    ],
    defaultCuentaId: cuenta.id,
    bancoMismatch,
  });
  return mensajeConfirmarImportacion({
    companyName,
    cuentaEtiqueta: etiquetaDe(cuenta),
    bancoDetectado: r.detectedBank ?? null,
    movimientos: r.transactions.length,
    bancoMismatch,
  });
}
