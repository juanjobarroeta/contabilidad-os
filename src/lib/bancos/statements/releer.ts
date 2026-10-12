// ─────────────────────────────────────────────────────────────────────────────
// VOLVER A LEER EL ORIGINAL DE UN ESTADO DE CUENTA YA GUARDADO.
//
// Dos casos reales en CENTRO (oct-2026) que ningún botón resolvía:
//
//  · Estados VIEJOS (agosto 2026): se importaron antes de que existieran las
//    filas del documento y los totales declarados. Sus movimientos están y
//    cuadran al centavo, pero sin filas ni totales la verificación no tiene
//    con qué compararlos, y volver a subir el PDF sólo devuelve «ya está
//    registrado» (mismo hash).
//  · Estados DETENIDOS (BBVA enero–julio 2026): la lectura con visión no pasó
//    sus propios controles, así que TODAS sus filas quedaron por revisar y no
//    se creó ni un movimiento. Ahora el formato BBVA se lee del texto y cuadra.
//
// Releer corre la extracción actual sobre el PDF guardado y rehace las FILAS
// del documento. Lo que ya decidió una persona no se toca: si alguna fila tiene
// una decisión humana, o el estado está verificado, se rehúsa.
//   - Una fila que corresponde a un movimiento que CREÓ este mismo documento
//     (mismo día e importe, en orden) queda ligada a él: es la misma lectura.
//   - El resto pasa por el mismo plan que una carga nueva (planRows): sólo una
//     identidad bancaria única liga sola; día e importe son candidatos.
//   - Si la extracción cuadra, las filas nuevas crean sus movimientos como en
//     una carga; si no cuadra, se quedan por revisar.
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { extractStatementFromDocument } from "../vision-statement";
import { pdfEstaProtegido } from "../pdf-crypt";
import { camposContraparte, parseSpei } from "../spei-descripcion";
import { clasificarCargoBancario } from "../clasificar-cargo";
import { primeraReglaQueEmpata, signoDeMonto, type FamiliaConcepto } from "../categorizar-concepto";
import { cents, planRows } from "./matching";
import { fromStored, parsedEvidence, MAX_STATEMENT_ROWS } from "./ingest";
import { autoVerificarEstado, type Diagnostico } from "./auto-verify";

export interface ResultadoReleer {
  ok: true;
  filas: number;
  ligadas: number;
  nuevas: number;
  porRevisar: number;
  cuadra: boolean | null;
  periodo: string | null;
  verificacion: Diagnostico | null;
  mensaje: string;
}

export async function releerEstado(companyId: string, batchId: string, userId: string): Promise<ResultadoReleer> {
  const doc = await prisma.importBatch.findFirst({
    where: { id: batchId, companyId, undoneAt: null },
    select: { id: true, bankAccountId: true, archivoPdf: true, archivoMime: true, verifiedAt: true,
      rows: { select: { id: true, status: true, decidedByUserId: true } } },
  });
  if (!doc) throw new Error("Documento no encontrado en esta empresa.");
  if (doc.verifiedAt) throw new Error("El estado ya está verificado. Reábrelo antes de volver a leerlo.");
  if (doc.rows.some((r) => r.decidedByUserId)) throw new Error("Este estado ya tiene filas decididas por una persona; no se vuelve a leer para no perder esas decisiones.");
  if (!doc.archivoPdf?.length) throw new Error("No hay archivo original guardado para volver a leer.");
  const bytes = Buffer.from(doc.archivoPdf);
  const mime = (doc.archivoMime ?? "application/pdf") as "application/pdf" | "image/jpeg" | "image/png" | "image/webp";
  if (mime === "application/pdf" && pdfEstaProtegido(bytes)) throw new Error("El original está protegido con contraseña; súbelo de nuevo con su contraseña.");

  const ex = await extractStatementFromDocument(bytes, mime, { companyId, subtipo: "bancos.vision_statement" });
  if (ex.transactions.length > MAX_STATEMENT_ROWS) throw new Error("El documento supera 20,000 movimientos.");
  const cuadra = ex.balanceCheck.cuadra === false || ex.controles?.cuadra === false ? false : ex.balanceCheck.cuadra ?? ex.controles?.cuadra ?? null;
  const periodo = ex.periodoInicio?.slice(0, 7) ?? ex.periodo ?? null;

  const res = await prisma.$transaction(async (db) => {
    await db.$queryRawUnsafe('SELECT id FROM "Company" WHERE id = $1 FOR UPDATE', companyId);
    const rows = ex.transactions.map((t) => parsedEvidence(t));
    const propios = (await db.bankTransaction.findMany({ where: { companyId, importBatchId: doc.id }, orderBy: [{ fecha: "asc" }, { id: "asc" }] })).map(fromStored);
    // 1. Los movimientos que creó este documento: misma lectura, se ligan en orden.
    const libres = new Map<string, string[]>();
    for (const m of propios) { const k = m.date + "|" + cents(m.amount); libres.set(k, [...(libres.get(k) ?? []), m.id]); }
    const ligadaA = rows.map((r) => { const k = r.date + "|" + cents(r.amount); const ids = libres.get(k); return ids?.length ? ids.shift()! : null; });
    // 2. El resto, contra los demás movimientos de la cuenta, como una carga nueva.
    const pendientes = rows.filter((_, i) => !ligadaA[i]);
    const dates = pendientes.map((r) => new Date(r.date).getTime());
    const otros = pendientes.length ? (await db.bankTransaction.findMany({ where: { companyId, bankAccountId: doc.bankAccountId, importBatchId: { not: doc.id },
      fecha: { gte: new Date(Math.min(...dates) - 7 * 86400000), lt: new Date(Math.max(...dates) + 8 * 86400000) } }, take: MAX_STATEMENT_ROWS })).map(fromStored) : [];
    const planes = planRows(pendientes, otros);
    const closed = new Set((await db.accountingPeriod.findMany({ where: { companyId, status: "CLOSED" }, select: { year: true, month: true } })).map((p) => `${p.year}-${String(p.month).padStart(2, "0")}`));
    const rules = await db.categorizationRule.findMany({ where: { companyId, activo: true, origen: "USER" } });

    await db.bankStatementRow.deleteMany({ where: { batchId: doc.id } });
    const nuevas: Prisma.BankTransactionCreateManyInput[] = [], filas: Prisma.BankStatementRowCreateManyInput[] = [];
    let ligadas = 0, creadas = 0, porRevisar = 0, p = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i], parsed = ex.transactions[i];
      let status: string, movementId: string | null, reason: string, candidateIds: string[] = [];
      if (ligadaA[i]) {
        status = "LINKED"; movementId = ligadaA[i]; reason = "Misma lectura del original: el movimiento lo creó este documento."; ligadas++;
      } else {
        const plan = planes[p++];
        status = plan.status; movementId = plan.movementId; reason = plan.reason; candidateIds = plan.candidateIds;
        if (status === "NEW" && (cuadra === false || closed.has(row.date.slice(0, 7)))) {
          status = "REVIEW"; movementId = null;
          reason = cuadra === false ? "La extracción no pasó los controles del documento. Revisa esta fila antes de importarla." : "El periodo está cerrado. El original se conservó sin modificar sus movimientos.";
        }
        if (status === "NEW") {
          const spei = parseSpei(parsed.descripcion, parsed.claveRastreoRaw, parsed.sublineas);
          const regla = primeraReglaQueEmpata(parsed.descripcion, signoDeMonto(parsed.monto), rules.map((r) => ({ id: r.id, pattern: r.pattern,
            matchType: r.matchType, familia: r.familia as FamiliaConcepto, signo: (r.signo as "CREDITO" | "DEBITO" | null) ?? undefined })));
          const propuesta = regla?.familia ?? clasificarCargoBancario(parsed.descripcion, parsed.monto);
          const categoria = propuesta === "INTERNAL_TRANSFER" ? null : propuesta;
          nuevas.push({ id: row.id, companyId, bankAccountId: doc.bankAccountId, fecha: parsed.fecha, monto: parsed.monto, descripcion: parsed.descripcion,
            saldo: parsed.saldo ?? null, referencia: parsed.referencia ?? row.time ?? null, operationTime: row.time, bankReferenceId: row.bankId,
            tipo: parsed.monto >= 0 ? "CREDITO" : "DEBITO", status: categoria ? "IGNORED" : "UNMATCHED", notes: categoria ?? null,
            source: "UPLOAD_PDF", importBatchId: doc.id, ...camposContraparte(spei) });
          creadas++;
        } else if (status === "LINKED") ligadas++; else porRevisar++;
      }
      filas.push({ batchId: doc.id, rowNumber: i + 1, pageNumber: (parsed as { sourcePage?: number }).sourcePage ?? null,
        parsed: { ...row, sourceRow: i + 1, sublines: parsed.sublineas ?? [] } as Prisma.InputJsonValue, movementId, status, reason, candidateIds });
    }
    for (let i = 0; i < nuevas.length; i += 1000) await db.bankTransaction.createMany({ data: nuevas.slice(i, i + 1000) });
    for (let i = 0; i < filas.length; i += 1000) await db.bankStatementRow.createMany({ data: filas.slice(i, i + 1000) });
    await db.importBatch.update({ where: { id: doc.id }, data: {
      periodo, periodStart: ex.periodoInicio ?? null, periodEnd: ex.periodoFin ?? null, banco: ex.banco ?? undefined,
      declaredAccount: ex.numeroCuenta, declaredCurrency: ex.moneda ?? null, parsedCount: rows.length,
      saldoInicial: ex.balanceCheck.saldoInicial, saldoFinal: ex.balanceCheck.saldoFinal, cuadro: cuadra,
      controls: ex.controlesDeclarados ? (ex.controlesDeclarados as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      warnings: ex.warnings, count: { increment: creadas },
    } });
    await db.auditLog.create({ data: { companyId, userId, accion: "bancos.statement.reread", entidad: "ImportBatch", entidadId: doc.id,
      detalle: { filas: rows.length, ligadas, creadas, porRevisar, cuadra, periodo } } });
    return { filas: rows.length, ligadas, nuevas: creadas, porRevisar };
  }, { timeout: 120000 });

  const { invalidarCierre } = await import("@/lib/cierre/evaluar");
  invalidarCierre(companyId);
  let verificacion: Diagnostico | null = null;
  try { verificacion = await autoVerificarEstado(companyId, batchId, userId); } catch { verificacion = null; }
  const mensaje = `Se volvió a leer el original: ${res.filas} filas (${res.ligadas} ligadas, ${res.nuevas} movimientos nuevos, ${res.porRevisar} por revisar).` +
    (verificacion?.verificado ? " Estado verificado automáticamente." : verificacion?.motivos.length ? " Queda por revisar: " + verificacion.motivos[0] : "");
  return { ok: true, ...res, cuadra, periodo, verificacion, mensaje };
}
