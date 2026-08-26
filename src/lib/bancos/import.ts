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
 * y re-subir el mismo archivo sigue siendo un no-op. Cuando la fuente trae
 * hora (formato pegado del portal) la regla es POR HORA: dos pegados
 * parciales pueden traer cada uno un movimiento idéntico del mismo día y
 * ambos entran (la hora, persistida en referencia, los distingue).
 *
 * Auto-categorize on import: bank fees, SAT payments, and internal
 * transfers go straight to IGNORED with a notes tag, so the UNMATCHED
 * inbox stays focused on items that actually need a CFDI/Gasto match.
 */

import { prisma } from "@/lib/prisma";
import * as XLSX from "xlsx";
import { parseStatement, type ParseResult, type ParsedTransaction, type RowDescartada } from "@/lib/bank-parser";
import { autoConciliarEmpresa } from "@/lib/bancos/auto-conciliar";
import { claveDeDuplicado, planImportacionConHora } from "@/lib/bancos/dedup";
import { cuentaTieneIngestExterno, ERROR_CUENTA_PUENTE } from "@/lib/bancos/fuentes";
import { primeraReglaQueEmpata, signoDeMonto, type FamiliaConcepto } from "@/lib/bancos/categorizar-concepto";
import { decodificarEstadoDeCuenta, esExcelBinario } from "@/lib/bancos/decodificar";
import { camposContraparte, parseSpei } from "@/lib/bancos/spei-descripcion";
import { nombresPorRfc } from "@/lib/bancos/contraparte-nombre";
import { vincularComisionesDeCuenta } from "@/lib/bancos/comisiones-repo";

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
  /** Metadatos del lote (para el "deshacer última importación"). */
  banco?: string | null;
  periodo?: string | null;
  /** Saldos que DECLARA el estado de cuenta — el ancla de la conciliación
   *  bancaria. El extractor ya los lee; aquí se persisten en vez de tirarse. */
  saldoInicial?: number | null;
  saldoFinal?: number | null;
  /** Documento original (PDF/imagen) — evidencia de la importación. */
  archivo?: { bytes: Uint8Array; nombre: string; mime: string } | null;
  /** Resultado del cuadre de saldos al importar (false = importado con force). */
  cuadro?: boolean | null;
}): Promise<{ imported: number; skipped: number; batchId: string | null }> {
  const { bankAccountId, companyId, transactions, source = "UPLOAD" } = opts;
  let imported = 0;
  let skipped = 0;

  // Lote de importación: agrupa lo que entra en esta subida para poder DESHACERLO
  // exactamente después. Se crea antes de insertar y se sella con el conteo al
  // final; si no entró nada (todo duplicado), se descarta el lote vacío.
  const batch = await prisma.importBatch.create({
    data: {
      companyId,
      bankAccountId,
      source,
      banco: opts.banco ?? null,
      periodo: opts.periodo ?? null,
      saldoInicial: opts.saldoInicial ?? null,
      saldoFinal: opts.saldoFinal ?? null,
      ...(opts.archivo
        ? {
            // Copia a un Uint8Array respaldado por ArrayBuffer (Prisma Bytes
            // no acepta el ArrayBufferLike de Buffer).
            archivoPdf: new Uint8Array(opts.archivo.bytes),
            archivoNombre: opts.archivo.nombre,
            archivoMime: opts.archivo.mime,
          }
        : {}),
      cuadro: opts.cuadro ?? null,
      count: 0,
    },
    select: { id: true },
  });

  // Regla de conteo por clave (día + monto + descripción + referencia):
  // D = movimientos que YA existían en la BD para esa clave (medido ANTES de
  // insertar nada de este archivo — por eso se cachea el conteo la primera
  // vez que vemos la clave, para que nuestras propias inserciones no lo
  // inflen), F = ocurrencias en el archivo. Se importan max(0, F − D) y las
  // D primeras ocurrencias se omiten como posibles duplicados. Cuando la
  // fuente trae HORA (formato pegado del portal), ésta identifica al
  // movimiento dentro del día — así dos pegados PARCIALES pueden traer, cada
  // uno, un SPEI idéntico del mismo día y ambos entran. Ver
  // src/lib/bancos/dedup.ts para la regla completa. La hora se persiste en
  // `referencia` (el pegado no trae referencia bancaria), de modo que los
  // re-pegados futuros la encuentran con la MISMA consulta exacta de siempre.
  const conteoEnBD = new Map<string, number>();
  const conteoConHora = new Map<string, number>();
  const filas: { clave: string; hora: string | null }[] = [];
  for (const tx of transactions) {
    const clave = claveDeDuplicado(tx);
    const hora = tx.referencia ? null : (tx.hora ?? null);
    filas.push({ clave, hora });
    const fechaStart = new Date(tx.fecha);
    fechaStart.setHours(0, 0, 0, 0);
    const fechaEnd = new Date(tx.fecha);
    fechaEnd.setHours(23, 59, 59, 999);
    const whereBase = {
      bankAccountId,
      fecha: { gte: fechaStart, lte: fechaEnd },
      monto: tx.monto,
      descripcion: tx.descripcion,
    };
    if (!conteoEnBD.has(clave)) {
      const d = await prisma.bankTransaction.count({
        where: { ...whereBase, referencia: tx.referencia ?? null },
      });
      conteoEnBD.set(clave, d);
    }
    if (hora) {
      const kh = `${clave}|${hora}`;
      if (!conteoConHora.has(kh)) {
        const d = await prisma.bankTransaction.count({
          where: { ...whereBase, referencia: hora },
        });
        conteoConHora.set(kh, d);
      }
    }
  }
  const plan = planImportacionConHora(
    filas,
    (clave) => conteoEnBD.get(clave) ?? 0,
    (clave, hora) => conteoConHora.get(`${clave}|${hora}`) ?? 0,
  );

  // Reglas de categorización CONFIRMADAS por el usuario (origen USER): se cargan
  // UNA sola vez (fuera del bucle) y se auto-aplican a cada movimiento que empate
  // — así los cargos recurrentes sin CFDI (Rappi, OpenAI, …) entran ya
  // categorizados en vez de saturar la bandeja de "sin conciliar". Las reglas del
  // usuario GANAN sobre los patrones hardcodeados de abajo. No se puede empatar
  // con un CFDI en este punto (el movimiento apenas se está creando; la
  // conciliación bancaria corre después), así que no hay riesgo de pisar un match.
  const reglasUsuario = await prisma.categorizationRule.findMany({
    where: { companyId, activo: true, origen: "USER" },
    select: { id: true, pattern: true, matchType: true, familia: true, signo: true },
  });
  const reglasMatcher = reglasUsuario.map((r) => ({
    id: r.id,
    pattern: r.pattern,
    matchType: r.matchType,
    familia: r.familia as FamiliaConcepto,
    signo: (r.signo as "CREDITO" | "DEBITO" | null) ?? undefined,
  }));
  // Conteo de aciertos por regla, para sellar hitCount al final del lote.
  const hitsPorRegla = new Map<string, number>();

  // La contraparte que el banco ya escribió en la descripción, parseada UNA
  // vez por fila. Y cuando el banco mandó sólo el RFC (BBVA en los traspasos),
  // el nombre se resuelve por RFC desde el catálogo de clientes y los CFDIs de
  // la empresa — una consulta por lote, match exacto o nada.
  const speiPorFila = transactions.map((tx, i) =>
    plan[i] ? parseSpei(tx.descripcion, tx.claveRastreoRaw) : null
  );
  const rfcsSinNombre = [
    ...new Set(
      speiPorFila
        .filter((s) => s?.contraparteRfc && !s.contraparteNombre)
        .map((s) => s!.contraparteRfc!)
    ),
  ];
  const nombresResueltos =
    rfcsSinNombre.length > 0
      ? await nombresPorRfc(companyId, rfcsSinNombre).catch(() => new Map<string, string>())
      : new Map<string, string>();

  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];

    if (!plan[i]) { skipped++; continue; }

    const desc = tx.descripcion;

    let status: "UNMATCHED" | "IGNORED" = "UNMATCHED";
    let notes: string | null = null;

    // 1) Regla del usuario (gana sobre los patrones hardcodeados).
    const reglaMatch =
      reglasMatcher.length > 0
        ? primeraReglaQueEmpata(desc, signoDeMonto(tx.monto), reglasMatcher)
        : null;
    if (reglaMatch) {
      status = "IGNORED";
      notes = reglaMatch.familia;
      hitsPorRegla.set(reglaMatch.id, (hitsPorRegla.get(reglaMatch.id) ?? 0) + 1);
    } else {
      // 2) Patrones hardcodeados de siempre.
      const isBankFee = /comisi[oó]n|iva\s+comisi/i.test(desc);
      const isTaxPayment =
        /pago\s+de\s+impuestos|^impuesto|recaudaci[oó]n|\bsat\b|tesofe/i.test(desc);
      const isInternalTransfer = /traspaso\s+(entre|a)\s+cuentas?\s+propias?|transferencia\s+propia/i.test(desc);
      const isBankNoise = /compensaci[oó]n\s+por\s+retraso/i.test(desc) || tx.monto === 0;
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
    }

    // La contraparte parseada arriba. No cambia el movimiento; le pone nombre,
    // RFC y CLABE a la otra parte para que la conciliación deje de adivinar
    // por monto.
    const spei = speiPorFila[i]!;
    const campos = camposContraparte(spei);
    if (campos.contraparteRfc && !campos.contraparteNombre) {
      campos.contraparteNombre = nombresResueltos.get(campos.contraparteRfc) ?? null;
    }

    await prisma.bankTransaction.create({
      data: {
        companyId,
        bankAccountId,
        fecha: tx.fecha,
        descripcion: tx.descripcion,
        monto: tx.monto,
        saldo: tx.saldo ?? null,
        // La hora del pegado viaja en referencia: identifica al movimiento
        // dentro del día para los pegados futuros (y se ve en conciliar).
        // Si el banco trae la hora etiquetada en la descripción (Bajío), sirve
        // igual y sin depender del formato pegado.
        referencia: tx.referencia ?? tx.hora ?? spei.hora ?? null,
        tipo: tx.monto >= 0 ? "CREDITO" : "DEBITO",
        status,
        notes,
        source,
        importBatchId: batch.id,
        ...campos,
      },
    });
    imported++;
  }

  // Sella el hitCount de cada regla que categorizó movimientos en este lote
  // (best-effort: la telemetría nunca debe tumbar una importación).
  for (const [ruleId, n] of hitsPorRegla) {
    if (n <= 0) continue;
    await prisma.categorizationRule
      .update({ where: { id: ruleId }, data: { hitCount: { increment: n } } })
      .catch(() => {});
  }

  // Sella el lote con el conteo real; si no entró nada, descártalo (nada que deshacer).
  if (imported > 0) {
    await prisma.importBatch.update({ where: { id: batch.id }, data: { count: imported } });
  } else {
    await prisma.importBatch.delete({ where: { id: batch.id } }).catch(() => {});
  }

  // Conciliación event-driven: en cuanto entra un estado de cuenta (subida CSV,
  // PDF/visión, o WhatsApp) corremos la auto-conciliación bancaria de alta
  // confianza para la empresa de inmediato, sin esperar al cron diario. Sólo
  // tiene sentido si realmente importamos movimientos nuevos. Idempotente —
  // sólo toca transacciones UNMATCHED. Best-effort: una falla aquí nunca rompe
  // la importación.
  if (imported > 0) {
    // ANTES de auto-conciliar: colgar cada comisión de la transferencia que la
    // generó. Así el conciliador ya no las ve como egresos sueltos buscando
    // factura — que es puro ruido, un renglón por cada SPEI del mes.
    try {
      await vincularComisionesDeCuenta(bankAccountId);
    } catch (e) {
      console.error(`[bancos/import] vincular comisiones falló para ${bankAccountId}:`, e);
    }
    try {
      await autoConciliarEmpresa(companyId);
    } catch (e) {
      console.error(`[bancos/import] auto-conciliar tras importar falló para ${companyId}:`, e);
    }
  }

  return { imported, skipped, batchId: imported > 0 ? batch.id : null };
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
}): Promise<ImportResult> {
  const { bankAccountId, companyId, fileContent, filename, encoding } = opts;

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
