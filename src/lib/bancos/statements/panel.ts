// ─────────────────────────────────────────────────────────────────────────────
// LA PÁGINA DE ESTADOS DE CUENTA: cuadrícula, controles y decisiones.
//
// La lista «Estados por revisar» de Bancos decía todo en un párrafo: «179
// filas de documentos siguen sin resolver. Cada fila del estado debe
// corresponder a una operación distinta. Una fila no coincide…» — diez motivos
// pegados, sin cifras, para siete meses seguidos. Nadie podía saber qué
// faltaba ni por cuánto. Aquí cada control es un renglón con lo esperado, lo
// encontrado y la diferencia; cada cuenta × mes tiene un estado; y las filas
// por resolver se ven junto a sus candidatos.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { accountReview, executeReview, previewReview, type ReviewRequest } from "./review";
import { cents, monthBounds, totals, type MovementEvidence } from "./matching";
import { fromStored } from "./ingest";
import { diagnosticarEstado } from "./auto-verify";
import { mesDeCobertura } from "../periodo-declarado";
import { conciliacionDelMes } from "../conciliacion-repo";

export type EstadoCelda = "VERIFICADO" | "POR_REVISAR" | "FALTA" | "SIN_DATOS";

export interface CeldaEstado {
  bankAccountId: string;
  month: number;
  estado: EstadoCelda;
  documentos: { id: string; archivo: string | null; verificado: boolean }[];
  movimientos: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const etiquetaCuenta = (a: { banco: string; nombre: string; numeroCuenta: string }) => `${a.banco} · ${a.nombre} ···${a.numeroCuenta.replace(/\D/g, "").slice(-4)}`;

/** La cuadrícula cuentas × meses del año, los documentos «Sin mes» y, si se pide un mes, de qué se compone la diferencia banco vs libros. */
export async function panelEstados(companyId: string, year: number, month?: number | null, hoy = new Date()) {
  monthBounds(year, 1);
  const cuentas = await prisma.bankAccount.findMany({ where: { companyId, tipo: { not: "CAJA" } }, select: { id: true, banco: true, nombre: true, numeroCuenta: true }, orderBy: { nombre: "asc" } });
  const docs = await prisma.importBatch.findMany({
    where: { companyId, undoneAt: null, archivoNombre: { not: null } },
    select: { id: true, bankAccountId: true, archivoNombre: true, periodo: true, periodStart: true, verifiedAt: true, verifiedYear: true, verifiedMonth: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  const movs: { bankAccountId: string; m: number; n: number }[] = await prisma.$queryRawUnsafe(
    `SELECT "bankAccountId", EXTRACT(MONTH FROM fecha)::int AS m, count(*)::int AS n FROM "BankTransaction"
     WHERE "companyId" = $1 AND fecha >= $2 AND fecha < $3 GROUP BY 1, 2`, companyId, new Date(Date.UTC(year, 0, 1)), new Date(Date.UTC(year + 1, 0, 1)));
  const ultimoMesCerrado = hoy.getUTCFullYear() > year ? 12 : hoy.getUTCFullYear() < year ? 0 : hoy.getUTCMonth(); // meses ya terminados

  const sinMes: { id: string; bankAccountId: string; cuenta: string; archivo: string | null; subidoEl: string; periodoImpreso: string | null }[] = [];
  const porCelda = new Map<string, CeldaEstado["documentos"]>();
  for (const d of docs) {
    const mes = d.verifiedYear && d.verifiedMonth ? { year: d.verifiedYear, month: d.verifiedMonth } : mesDeCobertura(d);
    if (!mes) {
      const c = cuentas.find((x) => x.id === d.bankAccountId);
      sinMes.push({ id: d.id, bankAccountId: d.bankAccountId, cuenta: c ? etiquetaCuenta(c) : "—", archivo: d.archivoNombre, subidoEl: d.createdAt.toISOString(), periodoImpreso: d.periodo });
      continue;
    }
    if (mes.year !== year) continue;
    const k = `${d.bankAccountId}|${mes.month}`;
    porCelda.set(k, [...(porCelda.get(k) ?? []), { id: d.id, archivo: d.archivoNombre, verificado: Boolean(d.verifiedAt) }]);
  }
  const celdas: CeldaEstado[] = [];
  for (const c of cuentas) for (let m = 1; m <= 12; m++) {
    const documentos = porCelda.get(`${c.id}|${m}`) ?? [];
    const movimientos = movs.find((x) => x.bankAccountId === c.id && x.m === m)?.n ?? 0;
    const estado: EstadoCelda = documentos.some((d) => d.verificado) ? "VERIFICADO" : documentos.length ? "POR_REVISAR" : m <= ultimoMesCerrado ? "FALTA" : "SIN_DATOS";
    celdas.push({ bankAccountId: c.id, month: m, estado, documentos, movimientos });
  }
  const explicacion = month ? await explicarDiferencia(companyId, year, month).catch(() => null) : null;
  return {
    year,
    cuentas: cuentas.map((c) => ({ id: c.id, etiqueta: etiquetaCuenta(c) })),
    celdas,
    sinMes,
    resumen: {
      verificados: celdas.filter((c) => c.estado === "VERIFICADO").length,
      porRevisar: celdas.filter((c) => c.estado === "POR_REVISAR").length,
      faltan: celdas.filter((c) => c.estado === "FALTA").length,
      sinMes: sinMes.length,
    },
    explicacion,
  };
}

/**
 * De qué se compone la diferencia banco vs libros del mes, en renglones. Los
 * mismos números que la conciliación (conciliacionDelMes), ordenados para
 * leerse: lo que dice el banco, lo que falta llevar al libro, lo que dice el
 * libro, y cuánto viene arrastrado del saldo inicial.
 */
export async function explicarDiferencia(companyId: string, year: number, month: number) {
  const c = await conciliacionDelMes(companyId, year, month);
  if (c.diferencia == null) return null;
  const causas: string[] = [];
  if (c.saldoInicialEstado != null && Math.abs(c.saldoInicialLibros - c.saldoInicialEstado) > 0.5) {
    causas.push(c.saldoInicialLibros === 0
      ? `El libro empieza el mes en $0 en Bancos y los estados en ${fmt(c.saldoInicialEstado)}: falta llevar el saldo inicial de bancos al libro (asiento de apertura o meses anteriores sin postear).`
      : `El saldo inicial del libro (${fmt(c.saldoInicialLibros)}) no es el de los estados (${fmt(c.saldoInicialEstado)}).`);
  }
  if (!c.mesPosteado) causas.push("El mes no está posteado: sus movimientos todavía no llegan al libro.");
  if (c.totalNoRegistrados !== 0) causas.push(`Hay movimientos del banco por ${fmt(c.totalNoRegistrados)} (neto) sin asiento en Bancos.`);
  if (c.totalAsientosSinMovimiento !== 0) causas.push(`Hay asientos en Bancos por ${fmt(c.totalAsientosSinMovimiento)} (neto) sin movimiento en el estado.`);
  return {
    renglones: [
      { concepto: "Saldo final según estados de cuenta", monto: c.saldoEstadoCuenta },
      { concepto: "− Movimientos del banco aún sin asiento en Bancos", monto: c.totalNoRegistrados },
      { concepto: "+ Asientos en Bancos sin movimiento en el estado", monto: c.totalAsientosSinMovimiento },
      { concepto: "= Saldo que debería tener el libro", monto: c.saldoEsperadoLibros },
      { concepto: "Saldo en libros (Bancos)", monto: c.saldoLibros },
      { concepto: "Diferencia", monto: c.diferencia },
    ],
    heredada: c.diferenciaHeredada,
    saldoInicialEstado: c.saldoInicialEstado,
    saldoInicialLibros: c.saldoInicialLibros,
    mesPosteado: c.mesPosteado,
    causas,
  };
}

const fmt = (n: number | null) => (n == null ? "—" : n.toLocaleString("es-MX", { style: "currency", currency: "MXN" }));

export interface Control { clave: string; nombre: string; ok: boolean | null; esperado: string | number | null; encontrado: string | number | null; diferencia: number | null; nota?: string }

/** El detalle de un documento: sus controles uno por uno, las filas por resolver con candidatos y los movimientos que el estado no cubre. */
export async function detalleEstado(companyId: string, batchId: string, hoy = new Date()) {
  const doc = await prisma.importBatch.findFirst({
    where: { id: batchId, companyId, undoneAt: null },
    select: { id: true, bankAccountId: true, archivoNombre: true, periodo: true, periodStart: true, periodEnd: true, saldoInicial: true, saldoFinal: true,
      controls: true, warnings: true, declaredAccount: true, declaredCurrency: true, verifiedAt: true, createdAt: true, parsedCount: true, count: true, cuadro: true,
      bankAccount: { select: { banco: true, nombre: true, numeroCuenta: true, clabe: true, moneda: true } } },
  });
  if (!doc) throw new Error("Documento no encontrado en esta empresa.");
  const mes = mesDeCobertura(doc);
  const base = {
    id: doc.id, archivo: doc.archivoNombre, cuenta: etiquetaCuenta(doc.bankAccount), bankAccountId: doc.bankAccountId,
    periodoImpreso: doc.periodo, periodStart: doc.periodStart, periodEnd: doc.periodEnd, subidoEl: doc.createdAt.toISOString(),
    verificado: Boolean(doc.verifiedAt), originalUrl: doc.archivoNombre ? `/api/bancos/import-batches/${doc.id}/pdf` : null,
    avisos: Array.isArray(doc.warnings) ? (doc.warnings as string[]) : [],
    // Sin filas del documento la verificación no tiene con qué cotejar: es un
    // estado importado antes de que se guardaran (se arregla releyéndolo).
    sinFilas: doc.parsedCount === 0, year: mes?.year ?? null, month: mes?.month ?? null,
  };
  if (!mes) {
    return { ...base, controles: [{ clave: "mes", nombre: "Mes que cubre el documento", ok: false, esperado: "un mes", encontrado: doc.periodo ?? "no se leyó", diferencia: null } satisfies Control],
      filas: [], sinCubrir: [], duplicados: 0, motivos: ["No se detectó el mes que cubre el documento."] };
  }
  const review = await accountReview({ companyId, bankAccountId: doc.bankAccountId, ...mes });
  const d = review.documents.find((x) => x.id === doc.id);
  const b = monthBounds(mes.year, mes.month);
  const filasDoc = d?.rows ?? [];
  const vivas = filasDoc.filter((r) => r.status !== "EXCLUDED").map((r) => r.parsed as unknown as MovementEvidence);
  const t = totals(vivas);
  const decl = (doc.controls ?? null) as { credits?: number | null; debits?: number | null; creditCount?: number | null; debitCount?: number | null } | null;
  const ini = doc.saldoInicial == null ? null : Number(doc.saldoInicial), fin = doc.saldoFinal == null ? null : Number(doc.saldoFinal);
  const dif = (a: number | null | undefined, e: number | null | undefined) => (a == null || e == null ? null : r2(a - e));
  const ligadas = new Set(filasDoc.filter((r) => r.status !== "EXCLUDED").map((r) => r.movementId).filter(Boolean));
  const sinCubrir = review.movements.filter((m) => !ligadas.has(m.id));
  const fuera = vivas.filter((r) => r.date < b.from || r.date > b.to).length;
  const ultimos4 = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "").slice(-4) || null;
  const cuentaOk = !doc.declaredAccount ? null : [doc.bankAccount.numeroCuenta, doc.bankAccount.clabe ?? ""].some((v) => v.replace(/\D/g, "").endsWith(ultimos4(doc.declaredAccount)!));
  const porResolver = filasDoc.filter((r) => r.status === "REVIEW");
  const sinFilas = filasDoc.length === 0;
  const controles: Control[] = [
    { clave: "mes", nombre: "Mes que cubre el documento", ok: true, esperado: b.from.slice(0, 7), encontrado: b.from.slice(0, 7), diferencia: null },
    { clave: "terminado", nombre: "El mes ya terminó", ok: b.end.getTime() <= hoy.getTime(), esperado: "sí", encontrado: b.end.getTime() <= hoy.getTime() ? "sí" : "no", diferencia: null },
    { clave: "cobertura", nombre: "Cubre el mes completo", ok: doc.periodStart && doc.periodEnd ? doc.periodStart <= b.from && doc.periodEnd >= b.to : null,
      esperado: `${b.from} a ${b.to}`, encontrado: doc.periodStart && doc.periodEnd ? `${doc.periodStart} a ${doc.periodEnd}` : doc.periodo, diferencia: null },
    { clave: "cuenta", nombre: "Cuenta impresa", ok: cuentaOk, esperado: ultimos4(doc.bankAccount.numeroCuenta), encontrado: ultimos4(doc.declaredAccount), diferencia: null },
    { clave: "moneda", nombre: "Moneda", ok: doc.declaredCurrency ? doc.declaredCurrency.toUpperCase() === doc.bankAccount.moneda.toUpperCase() : null, esperado: doc.bankAccount.moneda, encontrado: doc.declaredCurrency, diferencia: null },
    { clave: "saldo", nombre: "Saldo inicial + movimientos = saldo final", ok: sinFilas || ini == null || fin == null ? null : cents(ini) + cents(t.net) === cents(fin),
      esperado: fin, encontrado: sinFilas || ini == null ? null : r2(ini + t.net), diferencia: sinFilas ? null : dif(ini == null ? null : ini + t.net, fin) },
    { clave: "abonos", nombre: "Total de abonos", ok: sinFilas || decl?.credits == null ? null : cents(t.credits) === cents(decl.credits), esperado: decl?.credits ?? null, encontrado: sinFilas ? null : t.credits, diferencia: sinFilas ? null : dif(t.credits, decl?.credits) },
    { clave: "cargos", nombre: "Total de cargos", ok: sinFilas || decl?.debits == null ? null : cents(t.debits) === cents(decl.debits), esperado: decl?.debits ?? null, encontrado: sinFilas ? null : t.debits, diferencia: sinFilas ? null : dif(t.debits, decl?.debits) },
    { clave: "conteoAbonos", nombre: "Número de abonos", ok: sinFilas || decl?.creditCount == null ? null : t.creditCount === decl.creditCount, esperado: decl?.creditCount ?? null, encontrado: sinFilas ? null : t.creditCount, diferencia: sinFilas || decl?.creditCount == null ? null : t.creditCount - decl.creditCount },
    { clave: "conteoCargos", nombre: "Número de cargos", ok: sinFilas || decl?.debitCount == null ? null : t.debitCount === decl.debitCount, esperado: decl?.debitCount ?? null, encontrado: sinFilas ? null : t.debitCount, diferencia: sinFilas || decl?.debitCount == null ? null : t.debitCount - decl.debitCount },
    { clave: "porResolver", nombre: "Filas del estado por resolver", ok: porResolver.length === 0, esperado: 0, encontrado: porResolver.length, diferencia: porResolver.length },
    { clave: "fueraDelMes", nombre: "Filas fechadas fuera del mes", ok: fuera === 0, esperado: 0, encontrado: fuera, diferencia: fuera },
    { clave: "sinCubrir", nombre: "Movimientos del sistema que el estado no cubre", ok: sinCubrir.length === 0, esperado: 0, encontrado: sinCubrir.length, diferencia: sinCubrir.length },
    { clave: "duplicados", nombre: "Posibles duplicados por decidir", ok: review.duplicates.length === 0, esperado: 0, encontrado: review.duplicates.length, diferencia: review.duplicates.length },
  ];
  if (sinFilas) controles.push({ clave: "filas", nombre: "Filas del documento guardadas", ok: false, esperado: "las del estado", encontrado: 0, diferencia: null,
    nota: "Se importó antes de que se guardaran las filas y los totales del banco. «Volver a leer el original» los completa sin duplicar movimientos." });
  const diag = await diagnosticarEstado(companyId, doc.id).catch(() => null);
  return {
    ...base,
    controles,
    filas: porResolver.map((r) => {
      const p = r.parsed as unknown as MovementEvidence & { sublines?: string[] };
      return { id: r.id, fila: r.rowNumber, pagina: r.pageNumber, fecha: p.date, descripcion: p.description, monto: p.amount, referencia: p.reference ?? null, motivo: r.reason,
        candidatos: review.candidates.filter((m) => r.candidateIds.includes(m.id)).map((m) => ({ ...fromStored(m), status: m.status, source: m.source })) };
    }),
    sinCubrir: sinCubrir.slice(0, 300).map((m) => ({ ...fromStored(m), status: m.status, source: m.source })),
    duplicados: review.duplicates.length,
    hash: review.hash,
    motivos: diag?.motivos ?? [],
  };
}

/**
 * Asigna a mano el mes (y, si el documento no creó movimientos, la cuenta) de
 * un estado «Sin mes». Sólo escribe la cobertura declarada: el resto lo vuelve
 * a juzgar la verificación.
 */
export async function asignarMes(companyId: string, batchId: string, year: number, month: number, userId: string, bankAccountId?: string | null) {
  const b = monthBounds(year, month);
  const doc = await prisma.importBatch.findFirst({ where: { id: batchId, companyId, undoneAt: null }, select: { id: true, bankAccountId: true, verifiedAt: true, count: true } });
  if (!doc) throw new Error("Documento no encontrado en esta empresa.");
  if (doc.verifiedAt) throw new Error("El estado ya está verificado; reábrelo para cambiar su mes.");
  let cuenta = doc.bankAccountId;
  if (bankAccountId && bankAccountId !== doc.bankAccountId) {
    if (doc.count > 0) throw new Error("Este documento ya creó movimientos en su cuenta; para moverlo de cuenta, deshaz la carga y súbelo en la correcta.");
    const ok = await prisma.bankAccount.findFirst({ where: { id: bankAccountId, companyId }, select: { id: true } });
    if (!ok) throw new Error("Cuenta no encontrada en esta empresa.");
    cuenta = bankAccountId;
  }
  await prisma.importBatch.update({ where: { id: doc.id }, data: { periodStart: b.from, periodEnd: b.to, bankAccountId: cuenta } });
  await prisma.auditLog.create({ data: { companyId, userId, accion: "bancos.statement.assign_period", entidad: "ImportBatch", entidadId: doc.id,
    detalle: { year, month, bankAccountId: cuenta, antes: doc.bankAccountId } } });
  return { ok: true as const, year, month, bankAccountId: cuenta };
}

/**
 * Resuelve una fila: ligar a un movimiento, conservarla como operación nueva o
 * excluirla. Si la decisión mueve asientos (quitar un movimiento con póliza),
 * primero devuelve el efecto para que la persona lo confirme.
 */
export async function resolverFila(args: { companyId: string; batchId: string; rowId: string; resolucion: "LINK" | "NEW" | "EXCLUDE"; movementId?: string | null;
  motivo: string; effectExpected?: string | null; userId: string }) {
  const doc = await prisma.importBatch.findFirst({ where: { id: args.batchId, companyId: args.companyId, undoneAt: null }, select: { bankAccountId: true, periodo: true, periodStart: true } });
  if (!doc) throw new Error("Documento no encontrado en esta empresa.");
  const mes = mesDeCobertura(doc);
  if (!mes) throw new Error("Asigna primero el mes del documento.");
  const scope = { companyId: args.companyId, bankAccountId: doc.bankAccountId, ...mes };
  const review = await accountReview(scope);
  const request: ReviewRequest = { ...scope, expected: review.hash, operation: { type: "row", rowId: args.rowId, resolution: args.resolucion,
    ...(args.movementId ? { movementId: args.movementId } : {}), reason: args.motivo } };
  const preview = await previewReview(request);
  if (preview.ledgerEffect.length && args.effectExpected !== preview.effectHash) {
    return { necesitaConfirmar: true as const, resumen: preview.summary, efecto: preview.ledgerEffect, effectExpected: preview.effectHash };
  }
  const r = await executeReview({ ...request, effectExpected: preview.effectHash }, args.userId);
  return { ok: true as const, mensaje: r.message, resumen: preview.summary };
}

/** La cuenta de la empresa cuyo número o CLABE termina como la que imprime el documento. */
export async function cuentaPorTexto(companyId: string, texto: string) {
  const cuentas = await prisma.bankAccount.findMany({ where: { companyId, tipo: { not: "CAJA" } }, select: { id: true, numeroCuenta: true, clabe: true, banco: true, nombre: true } });
  const digitos = new Set((texto.match(/\d[\d\s-]{6,24}\d/g) ?? []).map((s) => s.replace(/\D/g, "")).filter((s) => s.length >= 8));
  const hits = cuentas.filter((c) => [c.numeroCuenta, c.clabe ?? ""].map((v) => v.replace(/\D/g, "")).some((v) => v.length >= 8 && [...digitos].some((d) => d === v || d.endsWith(v) || v.endsWith(d) && d.length >= 10)));
  return hits.length === 1 ? hits[0] : null;
}
