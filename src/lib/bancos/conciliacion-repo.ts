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
import { resolverSaldos, type SaldoConFuente } from "./saldos";
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

export class ConciliacionSinDatosError extends Error {
  constructor() {
    super("No hay movimientos bancarios del periodo para firmar");
    this.name = "ConciliacionSinDatosError";
  }
}

export class ConfirmacionSinActividadConDatosError extends Error {
  constructor() {
    super("El periodo ya tiene movimientos bancarios; no se puede declarar sin actividad");
    this.name = "ConfirmacionSinActividadConDatosError";
  }
}

export class ConfirmacionSinActividadNotaError extends Error {
  constructor() {
    super("Explica en al menos 10 caracteres por qué el periodo no tuvo actividad bancaria");
    this.name = "ConfirmacionSinActividadNotaError";
  }
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
  /** De dónde salió cada saldo (capturado, del estado, arrastrado, calculado). */
  fuenteInicial: SaldoConFuente;
  fuenteFinal: SaldoConFuente;
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
  confirmacionSinActividad: {
    confirmadaAt: string;
    confirmadaByUserId: string;
    nota: string;
  } | null;
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

  const [cuentasBancos, cuentasBancarias, txs, conciliaciones, cierre] = await Promise.all([
    // TODA la familia de Bancos: el motor postea en subcuentas por banco
    // (102.01.NN) — leer sólo la cuenta padre deja el libro en cero y marca
    // todos los movimientos como sin registrar.
    prisma.chartAccount.findMany({
      where: {
        companyId,
        isActive: true,
        OR: [{ subcuenta: { startsWith: COE_CODES.BANCOS } }, { cuentaSAT: COE_CODES.BANCOS, subcuenta: null }],
      },
      select: { id: true },
    }),
    prisma.bankAccount.findMany({
      where: { companyId },
      select: { id: true, banco: true, nombre: true, numeroCuenta: true },
      orderBy: { nombre: "asc" },
    }),
    prisma.bankTransaction.findMany({
      where: { companyId, fecha: { gte: inicio, lt: fin } },
      // La contraparte extraída (spei-descripcion + su barrido) viaja al papel
      // y a la mesa: sin estas columnas, la mesa enseñaba la sintaxis cruda del
      // banco («SPEI RECIBIDO, BCO:0014 …») teniendo el QUIÉN ya guardado.
      select: {
        id: true, fecha: true, descripcion: true, monto: true, status: true, notes: true, bankAccountId: true,
        contraparteNombre: true, contraparteRfc: true, conceptoPago: true, claveRastreo: true,
        contraparteClabe: true,
      },
      orderBy: { fecha: "asc" },
    }),
    prisma.conciliacionBancaria.findMany({ where: { companyId, year, month } }),
    prisma.cierrePeriodo.findUnique({
      where: { companyId_year_month: { companyId, year, month } },
      select: {
        sinActividadBancariaAt: true,
        sinActividadBancariaByUserId: true,
        sinActividadBancariaNota: true,
      },
    }),
  ]);

  const confirmacionSinActividad =
    cierre?.sinActividadBancariaAt &&
    cierre.sinActividadBancariaByUserId &&
    cierre.sinActividadBancariaNota
      ? {
          confirmadaAt: cierre.sinActividadBancariaAt.toISOString(),
          confirmadaByUserId: cierre.sinActividadBancariaByUserId,
          nota: cierre.sinActividadBancariaNota,
        }
      : null;
  const sinActividadBancariaConfirmada = txs.length === 0 && confirmacionSinActividad != null;

  const idsBancos = cuentasBancos.map((c) => c.id);
  if (idsBancos.length === 0) {
    const vacio = conciliarBancos({
      saldos: [],
      movimientos: [],
      asientos: [],
      saldoInicialLibros: 0,
      sinActividadBancariaConfirmada,
    });
    return {
      ...vacio,
      year,
      month,
      cuentas: [],
      auxiliar: [],
      movimientosBanco: [],
      resumen: confirmacionSinActividad
        ? resumenConciliacion(vacio)
        : "El catálogo no tiene cuenta de Bancos: no hay contra qué conciliar.",
      sinCuentaBancos: true,
      confirmacionSinActividad,
    };
  }

  // Asientos del mes en la cuenta de Bancos + saldo inicial (Σ de lo anterior)
  // + el estado del periodo + TODOS los asientos del mes (la numeración de
  // pólizas es por mes y sobre todas las cuentas: numerar sólo con los de
  // Bancos daría folios que no coinciden con el libro diario ni con el XML).
  const [asientosMes, previos, periodoContable, todosDelMes] = await Promise.all([
    prisma.accountingEntry.findMany({
      where: { companyId, chartAccountId: { in: idsBancos }, year, month },
      select: {
        id: true, fecha: true, descripcion: true, monto: true, tipo: true,
        fuente: true, referencia: true, referenciaTipo: true,
      },
      orderBy: { fecha: "asc" },
    }),
    prisma.accountingEntry.groupBy({
      by: ["tipo"],
      where: { companyId, chartAccountId: { in: idsBancos }, fecha: { lt: inicio } },
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
    (s, g) => s + (g.tipo === "CARGO" ? 1 : -1) * Number(g._sum.monto ?? 0),
    0
  );

  const asientos: AsientoBancosParaConciliar[] = asientosMes.map((e) => ({
    id: e.id,
    fecha: e.fecha.toISOString().slice(0, 10),
    concepto: e.descripcion,
    delta: (e.tipo === "CARGO" ? 1 : -1) * Number(e.monto),
    fuente: e.fuente,
    // Sólo los asientos que vienen de un movimiento bancario traen su id.
    bankTxId: e.referenciaTipo === "BANK_TX" ? e.referencia : null,
  }));

  // Un movimiento está REGISTRADO si generó asiento en Bancos. Se comprueba
  // contra el ledger y no contra su status, porque un mes sin postear no tiene
  // asientos aunque los movimientos estén conciliados con su CFDI.
  //
  // Los IGNORED cuentan como registrados aunque no tengan asiento propio: o son
  // la pierna receptora de un traspaso entre cuentas propias (su contra-asiento
  // ya la puso en libros — dejarla como partida inflaba la diferencia por el
  // monto del traspaso) o son ruido que el contador descartó a propósito. Si un
  // descarte deja al banco y al libro sin cuadrar, la diferencia lo delata como
  // «sin explicar» — más honesto que listarlo como partida y dar por conciliado
  // un hueco real.
  const conAsiento = new Set(asientos.map((a) => a.bankTxId).filter(Boolean) as string[]);
  const movimientos: MovimientoParaConciliar[] = txs.map((t) => ({
    id: t.id,
    fecha: t.fecha.toISOString().slice(0, 10),
    descripcion: t.descripcion,
    monto: Number(t.monto),
    cuentaBancariaId: t.bankAccountId,
    registrado: conAsiento.has(t.id) || t.status === "IGNORED",
    conciliado: t.status !== "UNMATCHED",
    status: t.status as "UNMATCHED" | "MATCHED" | "IGNORED",
    notes: t.notes,
    contraparteNombre: t.contraparteNombre,
    contraparteRfc: t.contraparteRfc,
    conceptoPago: t.conceptoPago,
    claveRastreo: t.claveRastreo,
    contraparteClabe: t.contraparteClabe,
  }));

  // Saldo del estado por cuenta: el capturado gana; si no hay, se propone el
  // del ImportBatch del periodo (lo que dijo el PDF que se subió).
  const porCuenta = new Map(conciliaciones.map((c) => [c.bankAccountId, {
    ...c,
    saldoInicialEstado: c.saldoInicialEstado === null ? null : Number(c.saldoInicialEstado),
    saldoFinalEstado: c.saldoFinalEstado === null ? null : Number(c.saldoFinalEstado),
  }]));
  const periodo = `${year}-${String(month).padStart(2, "0")}`;
  const lotes = (await prisma.importBatch.findMany({
    where: { companyId, periodo, undoneAt: null, saldoFinal: { not: null } },
    select: { bankAccountId: true, saldoInicial: true, saldoFinal: true },
    orderBy: { createdAt: "desc" },
  })).map((l) => ({
    ...l,
    saldoInicial: l.saldoInicial === null ? null : Number(l.saldoInicial),
    saldoFinal: l.saldoFinal === null ? null : Number(l.saldoFinal),
  }));
  const propuestos = new Map<string, { saldoInicial: number | null; saldoFinal: number | null }>();
  for (const l of lotes) if (!propuestos.has(l.bankAccountId)) propuestos.set(l.bankAccountId, l);

  // El ancla de cada cuenta: el último saldo CONOCIDO en o antes de este mes
  // (capturado o del estado importado). Con él ya no hay que teclear el saldo
  // de cada mes — se arrastra. Ver saldos.ts.
  const anclas = await anclasDeSaldo(companyId, cuentasBancarias.map((c) => c.id), year, month, inicio);

  const saldos: SaldoEstadoCuenta[] = [];
  const cuentas: CuentaConciliada[] = [];
  for (const cta of cuentasBancarias) {
    const etiqueta = `${cta.banco} · ${cta.nombre}`.trim();
    const guardada = porCuenta.get(cta.id);
    const propuesto = propuestos.get(cta.id);
    const delMes = movimientos.filter((m) => m.cuentaBancariaId === cta.id);
    const resueltos = resolverSaldos({
      capturadoInicial: guardada?.saldoInicialEstado ?? null,
      capturadoFinal: guardada?.saldoFinalEstado ?? null,
      estadoInicial: propuesto?.saldoInicial ?? null,
      estadoFinal: propuesto?.saldoFinal ?? null,
      ancla: anclas.get(cta.id) ?? null,
      netoDelMes: delMes.reduce((acc, m) => acc + m.monto, 0),
    });
    const saldoInicial = resueltos.inicial.valor;
    const saldoFinal = resueltos.final.valor;

    saldos.push({ cuentaBancariaId: cta.id, etiqueta, saldoInicial, saldoFinal });
    cuentas.push({
      bankAccountId: cta.id,
      etiqueta,
      saldoInicialEstado: saldoInicial,
      saldoFinalEstado: saldoFinal,
      saldoManual: guardada?.saldoManual ?? false,
      saldoPropuesto: guardada?.saldoFinalEstado == null && propuesto?.saldoFinal != null,
      fuenteInicial: resueltos.inicial,
      fuenteFinal: resueltos.final,
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

  const resultado = conciliarBancos({
    saldos,
    movimientos,
    asientos,
    saldoInicialLibros,
    mesPosteado,
    sinActividadBancariaConfirmada,
  });
  return {
    ...resultado,
    year,
    month,
    cuentas,
    auxiliar,
    movimientosBanco: movimientos,
    resumen: resumenConciliacion(resultado),
    sinCuentaBancos: false,
    confirmacionSinActividad,
  };
}

/** Confirma o revoca la declaración humana de un periodo sin actividad bancaria. */
export async function confirmarSinActividadBancaria(args: {
  companyId: string;
  year: number;
  month: number;
  userId: string;
  confirmada: boolean;
  nota?: string | null;
}) {
  const { companyId, year, month } = args;
  const nota = args.nota?.trim() || null;
  if (args.confirmada) {
    if (!nota || nota.length < 10) throw new ConfirmacionSinActividadNotaError();
    const { inicio, fin } = rangoMes(year, month);
    const movimientos = await prisma.bankTransaction.count({
      where: { companyId, fecha: { gte: inicio, lt: fin } },
    });
    if (movimientos > 0) throw new ConfirmacionSinActividadConDatosError();
  }

  const data = args.confirmada
    ? {
        sinActividadBancariaAt: new Date(),
        sinActividadBancariaByUserId: args.userId,
        sinActividadBancariaNota: nota,
      }
    : {
        sinActividadBancariaAt: null,
        sinActividadBancariaByUserId: null,
        sinActividadBancariaNota: null,
      };
  return prisma.cierrePeriodo.upsert({
    where: { companyId_year_month: { companyId, year, month } },
    update: data,
    create: { companyId, year, month, ...data },
  });
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
  if (args.conciliado) {
    const { inicio, fin } = rangoMes(year, month);
    const movimientos = await prisma.bankTransaction.count({
      where: { companyId, bankAccountId, fecha: { gte: inicio, lt: fin } },
    });
    if (movimientos === 0) throw new ConciliacionSinDatosError();
  }
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


// ── El ancla del saldo ───────────────────────────────────────────────────────

const MESES_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/**
 * Para cada cuenta, el último saldo CONOCIDO en o antes del mes pedido y el
 * neto de los movimientos entre ese punto y el primer día del mes.
 *
 * «Conocido» = capturado por alguien (ConciliacionBancaria.saldoFinalEstado) o
 * declarado por un estado de cuenta importado (ImportBatch.saldoFinal). Se toma
 * el más reciente de los dos; empatados, gana el capturado.
 *
 * Con esto el saldo se pide UNA vez por cuenta en toda su historia: los meses
 * siguientes se encadenan. No hay recursión — el neto sale de UNA agregación
 * por rango de fechas, así que da igual si el ancla es de hace tres años.
 */
async function anclasDeSaldo(
  companyId: string,
  bankAccountIds: string[],
  year: number,
  month: number,
  inicioDelMes: Date
): Promise<Map<string, { saldo: number; etiqueta: string; netoHastaInicioDelMes: number }>> {
  const out = new Map<string, { saldo: number; etiqueta: string; netoHastaInicioDelMes: number }>();
  if (bankAccountIds.length === 0) return out;
  const periodoActual = year * 100 + month;

  const [capturados, lotes] = await Promise.all([
    prisma.conciliacionBancaria.findMany({
      where: { companyId, bankAccountId: { in: bankAccountIds }, saldoFinalEstado: { not: null } },
      select: { bankAccountId: true, year: true, month: true, saldoFinalEstado: true },
      orderBy: [{ year: "desc" }, { month: "desc" }],
    }),
    prisma.importBatch.findMany({
      where: { companyId, bankAccountId: { in: bankAccountIds }, undoneAt: null, saldoFinal: { not: null }, periodo: { not: null } },
      select: { bankAccountId: true, periodo: true, saldoFinal: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  // Candidato por cuenta: el más reciente que NO sea posterior al mes pedido.
  // El mes pedido se excluye a propósito: ése lo resuelve resolverSaldos con lo
  // capturado / el estado del propio periodo, sin arrastre.
  type Cand = { periodo: number; saldo: number; etiqueta: string; duro: boolean };
  const mejor = new Map<string, Cand>();
  const proponer = (id: string, c: Cand) => {
    if (c.periodo >= periodoActual) return;
    const previo = mejor.get(id);
    if (!previo || c.periodo > previo.periodo || (c.periodo === previo.periodo && c.duro && !previo.duro)) {
      mejor.set(id, c);
    }
  };
  for (const c of capturados) {
    proponer(c.bankAccountId, {
      periodo: c.year * 100 + c.month,
      saldo: Number(c.saldoFinalEstado),
      etiqueta: `${MESES_ES[c.month - 1]} ${c.year}`,
      duro: true,
    });
  }
  for (const l of lotes) {
    const [y, m] = (l.periodo ?? "").split("-").map(Number);
    if (!y || !m || m < 1 || m > 12) continue;
    proponer(l.bankAccountId, {
      periodo: y * 100 + m,
      saldo: Number(l.saldoFinal),
      etiqueta: `el estado de cuenta de ${MESES_ES[m - 1]} ${y}`,
      duro: false,
    });
  }
  if (mejor.size === 0) return out;

  // Neto de los movimientos entre el fin del mes del ancla y el inicio de éste.
  const netos = await Promise.all(
    [...mejor.entries()].map(async ([id, c]) => {
      const y = Math.floor(c.periodo / 100);
      const m = c.periodo % 100;
      const desde = new Date(y, m, 1); // primer día del mes SIGUIENTE al ancla
      if (desde >= inicioDelMes) return [id, c, 0] as const;
      const agg = await prisma.bankTransaction.aggregate({
        where: { companyId, bankAccountId: id, fecha: { gte: desde, lt: inicioDelMes } },
        _sum: { monto: true },
      });
      return [id, c, Number(agg._sum.monto ?? 0)] as const;
    })
  );
  for (const [id, c, neto] of netos) {
    out.set(id, { saldo: c.saldo, etiqueta: c.etiqueta, netoHastaInicioDelMes: neto });
  }
  return out;
}
