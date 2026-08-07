// ─────────────────────────────────────────────────────────────────────────────
// Capa de I/O de la conciliación bancaria: arma las entradas del motor puro
// (conciliacion.ts) desde la base y persiste sólo lo que no se puede derivar.
//
// Qué se GUARDA y qué se RECALCULA:
//   - Se guarda el saldo que declara el estado de cuenta y la firma de quien
//     dio el mes por conciliado (ConciliacionBancaria).
//   - Se recalcula SIEMPRE el saldo en libros y las partidas en conciliación,
//     leyendo el ledger. Así el papel nunca queda desfasado si se re-postea el
//     mes o se concilia un movimiento que estaba suelto.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { COE_CODES } from "@/lib/contabilidad/catalog";
import { clavePoliza, numerarPolizas } from "@/lib/contabilidad/coe-polizas";
import {
  conciliarBancos,
  resumenConciliacion,
  type AsientoBancosParaConciliar,
  type ConciliacionResultado,
  type MovimientoParaConciliar,
  type SaldoEstadoCuenta,
} from "./conciliacion";

/** Ventana UTC del mes — la MISMA que usa postMonth, para que el mes conciliado
 *  sea exactamente el mes contable. */
function rangoMes(year: number, month: number) {
  return {
    inicio: new Date(Date.UTC(year, month - 1, 1)),
    fin: new Date(Date.UTC(year, month, 1)),
  };
}

export interface CuentaConciliada {
  bankAccountId: string;
  etiqueta: string;
  saldoInicialEstado: number | null;
  saldoFinalEstado: number | null;
  /** El saldo lo capturó una persona (no vino del estado de cuenta importado). */
  saldoManual: boolean;
  /** El saldo se propuso desde el ImportBatch del periodo y aún nadie lo confirmó. */
  saldoPropuesto: boolean;
  conciliadoAt: string | null;
  notas: string | null;
  movimientos: number;
  sinRegistrar: number;
}

/** Renglón del auxiliar de Bancos, con el folio de la póliza que lo generó. */
export interface RenglonAuxiliar {
  id: string;
  fecha: string;
  concepto: string;
  folioPoliza: string;
  fuente: string;
  delta: number;
  /** Movimiento bancario que lo originó; null si no viene del banco. */
  bankTxId: string | null;
}

export interface ConciliacionMes extends ConciliacionResultado {
  year: number;
  month: number;
  cuentas: CuentaConciliada[];
  /** Auxiliar COMPLETO de la cuenta de Bancos: el otro lado del cotejo. */
  auxiliar: RenglonAuxiliar[];
  /** Movimientos del banco del mes, con marca de si llegaron al libro. */
  movimientosBanco: MovimientoParaConciliar[];
  resumen: string;
  /** No hay cuenta contable de Bancos en el catálogo: nada que conciliar. */
  sinCuentaBancos: boolean;
}

/**
 * Arma la conciliación de un mes para toda la empresa.
 *
 * Es a nivel empresa porque el catálogo tiene UNA cuenta contable de Bancos:
 * su auxiliar es la suma de todos los bancos. El detalle por banco se conserva
 * en `cuentas` y en cada partida.
 */
export async function conciliacionDelMes(
  companyId: string,
  year: number,
  month: number
): Promise<ConciliacionMes> {
  const { inicio, fin } = rangoMes(year, month);

  const [cuentaBancos, cuentasBancarias, txs, conciliaciones] = await Promise.all([
    prisma.chartAccount.findFirst({
      where: {
        companyId,
        isActive: true,
        OR: [{ subcuenta: COE_CODES.BANCOS }, { cuentaSAT: COE_CODES.BANCOS, subcuenta: null }],
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    }),
    prisma.bankAccount.findMany({
      where: { companyId },
      select: { id: true, banco: true, nombre: true, numeroCuenta: true },
      orderBy: { nombre: "asc" },
    }),
    prisma.bankTransaction.findMany({
      where: { companyId, fecha: { gte: inicio, lt: fin } },
      select: { id: true, fecha: true, descripcion: true, monto: true, status: true, bankAccountId: true },
      orderBy: { fecha: "asc" },
    }),
    prisma.conciliacionBancaria.findMany({ where: { companyId, year, month } }),
  ]);

  if (!cuentaBancos) {
    const vacio = conciliarBancos({ saldos: [], movimientos: [], asientos: [], saldoInicialLibros: 0 });
    return {
      ...vacio,
      year,
      month,
      cuentas: [],
      auxiliar: [],
      movimientosBanco: [],
      resumen: "El catálogo no tiene cuenta de Bancos: no hay contra qué conciliar.",
      sinCuentaBancos: true,
    };
  }

  // Asientos del mes en la cuenta de Bancos + saldo inicial (Σ de lo anterior)
  // + el estado del periodo + TODOS los asientos del mes (la numeración de
  // pólizas es por mes y sobre todas las cuentas: numerar sólo con los de
  // Bancos daría folios que no coinciden con el libro diario ni con el XML).
  const [asientosMes, previos, periodoContable, todosDelMes] = await Promise.all([
    prisma.accountingEntry.findMany({
      where: { companyId, chartAccountId: cuentaBancos.id, year, month },
      select: {
        id: true, fecha: true, descripcion: true, monto: true, tipo: true,
        fuente: true, referencia: true, referenciaTipo: true,
      },
      orderBy: { fecha: "asc" },
    }),
    prisma.accountingEntry.groupBy({
      by: ["tipo"],
      where: { companyId, chartAccountId: cuentaBancos.id, fecha: { lt: inicio } },
      _sum: { monto: true },
    }),
    prisma.accountingPeriod.findUnique({
      where: { companyId_year_month: { companyId, year, month } },
      select: { status: true },
    }),
    prisma.accountingEntry.findMany({
      where: { companyId, year, month },
      select: { fecha: true, descripcion: true, fuente: true, referencia: true, referenciaTipo: true },
      // El MISMO orden que los demás alimentadores de numerarPolizas (coe-polizas,
      // coe-auxiliares, libro-diario): sin él, una póliza con asientos en dos
      // fechas puede numerar distinto aquí que en el libro diario y el XML.
      orderBy: { fecha: "asc" },
    }),
  ]);

  const saldoInicialLibros = previos.reduce(
    (s, g) => s + (g.tipo === "CARGO" ? 1 : -1) * (g._sum.monto ?? 0),
    0
  );

  const asientos: AsientoBancosParaConciliar[] = asientosMes.map((e) => ({
    id: e.id,
    fecha: e.fecha.toISOString().slice(0, 10),
    concepto: e.descripcion,
    delta: (e.tipo === "CARGO" ? 1 : -1) * e.monto,
    fuente: e.fuente,
    // Sólo los asientos que vienen de un movimiento bancario traen su id.
    bankTxId: e.referenciaTipo === "BANK_TX" ? e.referencia : null,
  }));

  // Un movimiento está REGISTRADO si generó asiento en Bancos. Se comprueba
  // contra el ledger y no contra su status, porque un mes sin postear no tiene
  // asientos aunque los movimientos estén conciliados con su CFDI.
  const conAsiento = new Set(asientos.map((a) => a.bankTxId).filter(Boolean) as string[]);
  const movimientos: MovimientoParaConciliar[] = txs.map((t) => ({
    id: t.id,
    fecha: t.fecha.toISOString().slice(0, 10),
    descripcion: t.descripcion,
    monto: t.monto,
    cuentaBancariaId: t.bankAccountId,
    registrado: conAsiento.has(t.id),
  }));

  // Saldo del estado por cuenta: el capturado gana; si no hay, se propone el
  // del ImportBatch del periodo (lo que dijo el PDF que se subió).
  const porCuenta = new Map(conciliaciones.map((c) => [c.bankAccountId, c]));
  const periodo = `${year}-${String(month).padStart(2, "0")}`;
  const lotes = await prisma.importBatch.findMany({
    where: { companyId, periodo, undoneAt: null, saldoFinal: { not: null } },
    select: { bankAccountId: true, saldoInicial: true, saldoFinal: true },
    orderBy: { createdAt: "desc" },
  });
  const propuestos = new Map<string, { saldoInicial: number | null; saldoFinal: number | null }>();
  for (const l of lotes) if (!propuestos.has(l.bankAccountId)) propuestos.set(l.bankAccountId, l);

  const saldos: SaldoEstadoCuenta[] = [];
  const cuentas: CuentaConciliada[] = [];
  for (const cta of cuentasBancarias) {
    const etiqueta = `${cta.banco} · ${cta.nombre}`.trim();
    const guardada = porCuenta.get(cta.id);
    const propuesto = propuestos.get(cta.id);
    const saldoFinal = guardada?.saldoFinalEstado ?? propuesto?.saldoFinal ?? null;
    const saldoInicial = guardada?.saldoInicialEstado ?? propuesto?.saldoInicial ?? null;
    const delMes = movimientos.filter((m) => m.cuentaBancariaId === cta.id);

    saldos.push({ cuentaBancariaId: cta.id, etiqueta, saldoInicial, saldoFinal });
    cuentas.push({
      bankAccountId: cta.id,
      etiqueta,
      saldoInicialEstado: saldoInicial,
      saldoFinalEstado: saldoFinal,
      saldoManual: guardada?.saldoManual ?? false,
      saldoPropuesto: guardada?.saldoFinalEstado == null && propuesto?.saldoFinal != null,
      conciliadoAt: guardada?.conciliadoAt?.toISOString() ?? null,
      notas: guardada?.notas ?? null,
      movimientos: delMes.length,
      sinRegistrar: delMes.filter((m) => !m.registrado).length,
    });
  }

  const mesPosteado = periodoContable?.status === "POSTED" || periodoContable?.status === "CLOSED";

  // Folio de póliza de cada renglón: el MISMO que muestra el libro diario y el
  // que lleva el XML de pólizas (NumUnIdenPol), para que el contador pueda ir
  // del auxiliar a su póliza sin traducir folios.
  const folios = numerarPolizas(
    todosDelMes.map((e) => ({
      referencia: e.referencia,
      referenciaTipo: e.referenciaTipo,
      fuente: e.fuente,
      fecha: e.fecha.toISOString().slice(0, 10),
      concepto: e.descripcion,
    }))
  );
  // Clave de póliza por asiento (desde las filas crudas); el resto del renglón
  // sale de `asientos`, que YA fijó la convención de signo y la regla de
  // bankTxId — así no hay dos copias que puedan desincronizarse.
  const clavePorId = new Map(
    asientosMes.map((e) => [
      e.id,
      clavePoliza({
        referencia: e.referencia,
        referenciaTipo: e.referenciaTipo,
        fuente: e.fuente,
        fecha: e.fecha.toISOString().slice(0, 10),
        concepto: e.descripcion,
      }),
    ])
  );
  const auxiliar = asientos.map((a) => ({
    ...a,
    folioPoliza: folios.get(clavePorId.get(a.id) ?? "") ?? "—",
  }));

  const resultado = conciliarBancos({ saldos, movimientos, asientos, saldoInicialLibros, mesPosteado });
  return {
    ...resultado,
    year,
    month,
    cuentas,
    auxiliar,
    movimientosBanco: movimientos,
    resumen: resumenConciliacion(resultado),
    sinCuentaBancos: false,
  };
}

/** Captura o corrige el saldo del estado de cuenta de una cuenta y mes. */
export async function guardarSaldoEstado(args: {
  companyId: string;
  bankAccountId: string;
  year: number;
  month: number;
  saldoFinalEstado: number | null;
  saldoInicialEstado: number | null;
  notas?: string | null;
}) {
  const { companyId, bankAccountId, year, month } = args;
  return prisma.conciliacionBancaria.upsert({
    where: { bankAccountId_year_month: { bankAccountId, year, month } },
    update: {
      saldoFinalEstado: args.saldoFinalEstado,
      saldoInicialEstado: args.saldoInicialEstado,
      saldoManual: true,
      ...(args.notas !== undefined ? { notas: args.notas } : {}),
    },
    create: {
      companyId,
      bankAccountId,
      year,
      month,
      saldoFinalEstado: args.saldoFinalEstado,
      saldoInicialEstado: args.saldoInicialEstado,
      saldoManual: true,
      notas: args.notas ?? null,
    },
  });
}

/** Firma (o retira la firma de) la conciliación de una cuenta y mes. */
export async function firmarConciliacion(args: {
  companyId: string;
  bankAccountId: string;
  year: number;
  month: number;
  userId: string;
  conciliado: boolean;
}) {
  const { companyId, bankAccountId, year, month } = args;
  return prisma.conciliacionBancaria.upsert({
    where: { bankAccountId_year_month: { bankAccountId, year, month } },
    update: {
      conciliadoAt: args.conciliado ? new Date() : null,
      conciliadoByUserId: args.conciliado ? args.userId : null,
    },
    create: {
      companyId,
      bankAccountId,
      year,
      month,
      conciliadoAt: args.conciliado ? new Date() : null,
      conciliadoByUserId: args.conciliado ? args.userId : null,
    },
  });
}
