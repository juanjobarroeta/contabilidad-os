// ─────────────────────────────────────────────────────────────────────────────
// Asientos con fuente HOSPITAL (docs/HOSPITAL.md → P3 «Contabilidad»).
//
// El CFDI ya lleva el ingreso al libro (posting.ts, piernas de contabilidad/
// hospital.ts). Lo que el CFDI NO sabe lo asienta el módulo en el momento del
// hecho, dentro de la misma transacción que lo registra:
//
//   · Salida de farmacia a un paciente (SALIDA_APLICACION, al costo del lote):
//         CARGO  COSTO_FARMACIA          501.01
//         ABONO  INVENTARIO_FARMACIA     115.01
//     Costeo PERPETUO: la compra entró al inventario con el CFDI del
//     proveedor (G01 → 115) y sale al costo cuando se aplica. Con esto activo
//     NO se captura conteo de inventario periódico para farmacia — el hub
//     derivaría el costo por diferencia y lo contaría dos veces.
//
//   · Alta del episodio — honorarios devengados por médico. El hospital cobra
//     el honorario por cuenta del médico: la pierna del CFDI ya ABONÓ el
//     pasivo HONORARIOS_POR_CUENTA_DE_TERCEROS (205.06) por el bruto. Al alta
//     se reconoce lo que el hospital, persona moral, RETIENE al médico persona
//     física (Art. 106 último párrafo LISR: 10 % de ISR; Art. 1-A-II-a LIVA y
//     Art. 3 RLIVA: dos terceras partes del IVA que le traslade — casi siempre
//     cero, porque el honorario médico está exento, Art. 15-XIV LIVA):
//         CARGO  HONORARIOS_POR_CUENTA_DE_TERCEROS   (baja el neto a pagar)
//         ABONO  RETENCION_ISR_HONORARIOS  216.04   honorario × 10 %
//         CARGO  HONORARIOS_POR_CUENTA_DE_TERCEROS
//         ABONO  RETENCION_IVA_HONORARIOS  216.10   IVA × 2/3 (si el cargo lleva IVA)
//     El saldo del pasivo queda en el NETO que se dispersa al médico; el entero
//     de las retenciones lo hace el motor fiscal del hub. Médico persona moral
//     o sin RFC: nada que retener, nada que asentar. Devengo al alta, que es
//     cuando el honorario queda firme; el pago (banco) lo concilia el hub.
//
//   · Depósito del paciente:
//         RECIBIDO  CARGO CAJA (efectivo) o BANCOS / ABONO ANTICIPOS_PACIENTES 206.01
//         APLICADO  CARGO ANTICIPOS_PACIENTES / ABONO CLIENTES 105.01
//         DEVUELTO  CARGO ANTICIPOS_PACIENTES / ABONO CAJA o BANCOS
//         CANCELADO (sólo si RECIBIDO ya estaba en el libro): reversa del recibido
//
// Idempotencia: cada asiento es un par CARGO/ABONO con (referencia,
// referenciaTipo) únicos — no se repite si ya está en el libro— y el origen
// marca `asientoAt`. Todo es no-op con `HospConfig.contabilidadActiva = false`,
// y `postMonth` conserva la fuente HOSPITAL al re-postear el mes.
//
// Los períodos son los del libro (mes UTC de la fecha), igual que
// postBalancedEntry y postMonth.
// ─────────────────────────────────────────────────────────────────────────────

import type { HospDepositoEstado, HospFormaPago, HospMovimientoTipo, Prisma, PrismaClient } from "@prisma/client";
import { assertPeriodoAbierto } from "../contabilidad/candado";
import { PeriodoCerradoError } from "../contabilidad/ejercicio";
import {
  cargarConfigContable,
  codigoDeCuenta,
  mapaCuentas,
  resolverCuenta,
  type ClaveMotor,
  type ConfigContable,
  type CuentaResuelta,
} from "./contabilidad";
import { HospitalError } from "./errores";
import { r2 } from "./util";

type Db = PrismaClient | Prisma.TransactionClient;

export const FUENTE_HOSPITAL = "HOSPITAL" as const;

export const TIPO_ASIENTO = {
  FARMACIA_SALIDA: "HOSP_FARMACIA_SALIDA",
  HONORARIOS_RET_ISR: "HOSP_HONORARIOS_RET_ISR",
  HONORARIOS_RET_IVA: "HOSP_HONORARIOS_RET_IVA",
  DEPOSITO_RECIBIDO: "HOSP_DEPOSITO_RECIBIDO",
  DEPOSITO_APLICADO: "HOSP_DEPOSITO_APLICADO",
  DEPOSITO_DEVUELTO: "HOSP_DEPOSITO_DEVUELTO",
  DEPOSITO_CANCELADO: "HOSP_DEPOSITO_CANCELADO",
} as const;

export const TASA_RETENCION_ISR_HONORARIOS = 0.1;
export const FRACCION_RETENCION_IVA = 2 / 3;

/** Un asiento por escribir: par CARGO/ABONO por claves del motor. */
export interface AsientoPlan {
  fecha: Date;
  descripcion: string;
  monto: number;
  referencia: string;
  referenciaTipo: string;
  cargo: ClaveMotor;
  abono: ClaveMotor;
  /** Deja huella en el origen cuando el asiento ya está en el libro. */
  marcar: (tx: Db, at: Date) => Promise<void>;
}

export interface ContextoAsientos {
  companyId: string;
  config: ConfigContable;
  cuentas: Map<ClaveMotor, CuentaResuelta>;
}

export async function contextoAsientos(db: Db, companyId: string): Promise<ContextoAsientos> {
  return { companyId, config: await cargarConfigContable(db, companyId), cuentas: new Map() };
}

export async function cuentaDe(db: Db, ctx: ContextoAsientos, clave: ClaveMotor): Promise<CuentaResuelta> {
  let cuenta = ctx.cuentas.get(clave);
  if (!cuenta) {
    cuenta = await resolverCuenta(db, ctx.companyId, clave, { config: ctx.config.cuentas });
    ctx.cuentas.set(clave, cuenta);
  }
  return cuenta;
}

/** ¿El par ya está en el libro? Idempotencia por referencia + tipo. */
export async function yaAsentado(db: Db, companyId: string, referencia: string, referenciaTipo: string): Promise<boolean> {
  const fila = await db.accountingEntry.findFirst({
    where: { companyId, fuente: FUENTE_HOSPITAL, referencia, referenciaTipo },
    select: { id: true },
  });
  return !!fila;
}

/** Escribe el par si no existe. true = escribió. */
export async function ejecutarPlan(tx: Db, ctx: ContextoAsientos, plan: AsientoPlan, ahora: Date = new Date()): Promise<boolean> {
  if (!(plan.monto > 0.005)) return false;
  if (await yaAsentado(tx, ctx.companyId, plan.referencia, plan.referenciaTipo)) return false;
  const cargo = await cuentaDe(tx, ctx, plan.cargo);
  const abono = await cuentaDe(tx, ctx, plan.abono);
  if (cargo.id === abono.id) {
    throw new HospitalError(409, `${plan.cargo} y ${plan.abono} resuelven a la misma cuenta (${codigoDeCuenta(cargo)}): corrige el mapa de cuentas`);
  }
  const year = plan.fecha.getUTCFullYear();
  const month = plan.fecha.getUTCMonth() + 1;
  // Ejercicio cerrado → 409 del módulo, para que la ruta clínica lo explique
  // en vez de caerse.
  try {
    await assertPeriodoAbierto(tx, ctx.companyId, year, month);
  } catch (e) {
    if (e instanceof PeriodoCerradoError) throw new HospitalError(e.status, e.message);
    throw e;
  }
  const base = {
    companyId: ctx.companyId,
    fecha: plan.fecha,
    year,
    month,
    descripcion: plan.descripcion,
    referencia: plan.referencia,
    referenciaTipo: plan.referenciaTipo,
    monto: r2(plan.monto),
    fuente: FUENTE_HOSPITAL,
  };
  await tx.accountingEntry.createMany({
    data: [
      { ...base, chartAccountId: cargo.id, tipo: "CARGO" },
      { ...base, chartAccountId: abono.id, tipo: "ABONO" },
    ],
  });
  await plan.marcar(tx, ahora);
  return true;
}

// ─── Farmacia ────────────────────────────────────────────────────────────────

export interface MovimientoParaAsiento {
  id: string;
  companyId: string;
  tipo: HospMovimientoTipo;
  cantidad: number | { toString(): string };
  costoUnitario: number | { toString(): string } | null;
  fecha: Date;
  asientoAt?: Date | null;
  /** Para la descripción del asiento (insumo · lote); opcional. */
  descripcion?: string | null;
}

/** Sólo la salida a un paciente con costo de lote se vuelve costo; MERMA/CADUCIDAD no son costo de venta. */
export function planSalidaFarmacia(m: MovimientoParaAsiento): AsientoPlan | null {
  if (m.tipo !== "SALIDA_APLICACION") return null;
  const cantidad = Math.abs(Number(m.cantidad));
  const costo = Number(m.costoUnitario ?? 0);
  const monto = r2(cantidad * costo);
  if (!(monto > 0.005)) return null;
  return {
    fecha: m.fecha,
    descripcion: `Costo de farmacia · ${m.descripcion?.trim() || `movimiento ${m.id}`}`,
    monto,
    referencia: m.id,
    referenciaTipo: TIPO_ASIENTO.FARMACIA_SALIDA,
    cargo: "COSTO_FARMACIA",
    abono: "INVENTARIO_FARMACIA",
    marcar: (tx, at) => tx.hospMovimientoInsumo.update({ where: { id: m.id }, data: { asientoAt: at } }).then(() => undefined),
  };
}

/** Hook de aplicar-insumo: dentro de su transacción, tras crear el movimiento. */
export async function asentarSalidaFarmacia(tx: Db, movimiento: MovimientoParaAsiento, ctx?: ContextoAsientos): Promise<number> {
  const c = ctx ?? (await contextoAsientos(tx, movimiento.companyId));
  if (!c.config.activa || movimiento.asientoAt) return 0;
  const plan = planSalidaFarmacia(movimiento);
  if (!plan) return 0;
  return (await ejecutarPlan(tx, c, plan)) ? 1 : 0;
}

// ─── Honorarios ──────────────────────────────────────────────────────────────

export interface CargoHonorario {
  id: string;
  medicoId: string | null;
  importe: number | { toString(): string };
  ivaTasa: number | { toString(): string } | null;
  medico: { id: string; nombre: string; rfc: string | null; supplier?: { rfc: string | null } | null } | null;
}

/** RFC de 13 posiciones = persona física (el de 12 es persona moral). */
export function esPersonaFisica(rfc: string | null | undefined): boolean {
  return (rfc ?? "").trim().length === 13;
}

export interface RetencionMedico {
  medicoId: string;
  nombre: string;
  honorario: number;
  iva: number;
  retencionIsr: number;
  retencionIva: number;
  cargoIds: string[];
}

/** Por médico: honorario bruto, IVA y lo que se le retiene. Sin RFC de PF → no aparece. */
export function retencionesPorMedico(cargos: CargoHonorario[], empresaRetiene: boolean): RetencionMedico[] {
  if (!empresaRetiene) return [];
  const porMedico = new Map<string, RetencionMedico>();
  for (const c of cargos) {
    if (!c.medicoId || !c.medico) continue;
    const rfc = c.medico.rfc ?? c.medico.supplier?.rfc ?? null;
    if (!esPersonaFisica(rfc)) continue;
    const importe = Number(c.importe);
    const iva = c.ivaTasa == null ? 0 : r2(importe * Number(c.ivaTasa));
    const acc = porMedico.get(c.medicoId) ?? {
      medicoId: c.medicoId,
      nombre: c.medico.nombre,
      honorario: 0,
      iva: 0,
      retencionIsr: 0,
      retencionIva: 0,
      cargoIds: [],
    };
    acc.honorario = r2(acc.honorario + importe);
    acc.iva = r2(acc.iva + iva);
    acc.cargoIds.push(c.id);
    porMedico.set(c.medicoId, acc);
  }
  for (const m of porMedico.values()) {
    m.retencionIsr = r2(m.honorario * TASA_RETENCION_ISR_HONORARIOS);
    m.retencionIva = r2(m.iva * FRACCION_RETENCION_IVA);
  }
  return [...porMedico.values()].filter((m) => m.retencionIsr > 0.005 || m.retencionIva > 0.005);
}

export function planesHonorarios(
  episodio: { id: string; folio: string; fechaAlta: Date | null },
  cargos: CargoHonorario[],
  empresaRetiene: boolean,
  ahora: Date = new Date()
): AsientoPlan[] {
  const fecha = episodio.fechaAlta ?? ahora;
  const planes: AsientoPlan[] = [];
  for (const m of retencionesPorMedico(cargos, empresaRetiene)) {
    const marcar = (tx: Db, at: Date) =>
      tx.hospCargo.updateMany({ where: { id: { in: m.cargoIds } }, data: { asientoAt: at } }).then(() => undefined);
    const referencia = `${episodio.id}:${m.medicoId}`;
    if (m.retencionIsr > 0.005) {
      planes.push({
        fecha,
        descripcion: `Retención ISR 10 % honorarios ${m.nombre} · ${episodio.folio}`,
        monto: m.retencionIsr,
        referencia,
        referenciaTipo: TIPO_ASIENTO.HONORARIOS_RET_ISR,
        cargo: "HONORARIOS_POR_CUENTA_DE_TERCEROS",
        abono: "RETENCION_ISR_HONORARIOS",
        marcar,
      });
    }
    if (m.retencionIva > 0.005) {
      planes.push({
        fecha,
        descripcion: `Retención IVA 2/3 honorarios ${m.nombre} · ${episodio.folio}`,
        monto: m.retencionIva,
        referencia,
        referenciaTipo: TIPO_ASIENTO.HONORARIOS_RET_IVA,
        cargo: "HONORARIOS_POR_CUENTA_DE_TERCEROS",
        abono: "RETENCION_IVA_HONORARIOS",
        marcar,
      });
    }
  }
  return planes;
}

const cargosHonorarioPendientes = (tx: Db, companyId: string, episodioId: string) =>
  tx.hospCargo.findMany({
    where: { companyId, episodioId, categoria: "HONORARIO", cancelado: false, asientoAt: null, medicoId: { not: null } },
    select: {
      id: true,
      medicoId: true,
      importe: true,
      ivaTasa: true,
      medico: { select: { id: true, nombre: true, rfc: true, supplier: { select: { rfc: true } } } },
    },
  });

/** Hook del alta: dentro de su transacción, con la fecha de alta ya fijada. */
export async function asentarHonorarios(
  tx: Db,
  episodio: { id: string; companyId: string; folio: string; fechaAlta: Date | null },
  ctx?: ContextoAsientos
): Promise<number> {
  const c = ctx ?? (await contextoAsientos(tx, episodio.companyId));
  if (!c.config.activa) return 0;
  const cargos = await cargosHonorarioPendientes(tx, episodio.companyId, episodio.id);
  if (cargos.length === 0) return 0;
  let n = 0;
  for (const plan of planesHonorarios(episodio, cargos, c.config.empresaRetiene)) {
    if (await ejecutarPlan(tx, c, plan)) n++;
  }
  return n;
}

// ─── Depósitos ───────────────────────────────────────────────────────────────

export interface DepositoParaAsiento {
  id: string;
  companyId: string;
  fecha: Date;
  monto: number | { toString(): string };
  formaPago: HospFormaPago;
  estado: HospDepositoEstado;
  aplicadoAt?: Date | null;
  devueltoAt?: Date | null;
  referencia?: string | null;
  /** Folio del episodio, para la descripción. */
  folio?: string | null;
}

/**
 * Sólo el efectivo entra a una cuenta que el banco nunca ve. Tarjeta,
 * transferencia y cheque van a FONDOS_EN_TRANSITO y ahí esperan: el dinero
 * llega al banco días después (el adquirente liquida en lote y neto de
 * comisión), y quien lo baja a BANCOS es el movimiento bancario conciliado.
 * Si el cobro entrara directo a BANCOS, la misma cantidad se cargaría dos
 * veces: al cobrar en caja y al llegar el depósito.
 */
export const cuentaDeFormaPago = (formaPago: HospFormaPago): ClaveMotor =>
  formaPago === "EFECTIVO" ? "CAJA" : "FONDOS_EN_TRANSITO";

const enRango = (fecha: Date, rango?: { desde: Date; hasta: Date }) =>
  !rango || (fecha.getTime() >= rango.desde.getTime() && fecha.getTime() < rango.hasta.getTime());

/**
 * Las etapas del depósito que tocan el libro, cada una con su fecha. Con
 * `rango` sólo las que caen en él (el asentado mensual no debe escribir en
 * meses ajenos). La cancelación se reversa sólo en el hook (necesita saber si
 * el recibido ya se asentó; ver `asentarDeposito`).
 */
export function planesDeposito(d: DepositoParaAsiento, opts: { rango?: { desde: Date; hasta: Date }; ahora?: Date; reversarCancelado?: boolean } = {}): AsientoPlan[] {
  const monto = r2(Number(d.monto));
  if (!(monto > 0.005)) return [];
  const ahora = opts.ahora ?? new Date();
  const efectivo = cuentaDeFormaPago(d.formaPago);
  const quien = d.folio ? ` · ${d.folio}` : "";
  const marcar = (tx: Db, at: Date) => tx.hospDeposito.update({ where: { id: d.id }, data: { asientoAt: at } }).then(() => undefined);
  const planes: AsientoPlan[] = [];

  if (d.estado !== "CANCELADO" && enRango(d.fecha, opts.rango)) {
    planes.push({
      fecha: d.fecha,
      descripcion: `Depósito recibido${quien}`,
      monto,
      referencia: d.id,
      referenciaTipo: TIPO_ASIENTO.DEPOSITO_RECIBIDO,
      cargo: efectivo,
      abono: "ANTICIPOS_PACIENTES",
      marcar,
    });
  }
  if (d.estado === "APLICADO") {
    const fecha = d.aplicadoAt ?? ahora;
    if (enRango(fecha, opts.rango)) {
      planes.push({
        fecha,
        descripcion: `Depósito aplicado a la cuenta${quien}`,
        monto,
        referencia: d.id,
        referenciaTipo: TIPO_ASIENTO.DEPOSITO_APLICADO,
        cargo: "ANTICIPOS_PACIENTES",
        abono: "CLIENTES",
        marcar,
      });
    }
  }
  if (d.estado === "DEVUELTO") {
    const fecha = d.devueltoAt ?? ahora;
    if (enRango(fecha, opts.rango)) {
      planes.push({
        fecha,
        descripcion: `Depósito devuelto${quien}`,
        monto,
        referencia: d.id,
        referenciaTipo: TIPO_ASIENTO.DEPOSITO_DEVUELTO,
        cargo: "ANTICIPOS_PACIENTES",
        abono: efectivo,
        marcar,
      });
    }
  }
  if (d.estado === "CANCELADO" && opts.reversarCancelado && enRango(ahora, opts.rango)) {
    planes.push({
      fecha: ahora,
      descripcion: `Depósito cancelado (reversa del recibido)${quien}`,
      monto,
      referencia: d.id,
      referenciaTipo: TIPO_ASIENTO.DEPOSITO_CANCELADO,
      cargo: "ANTICIPOS_PACIENTES",
      abono: efectivo,
      marcar,
    });
  }
  return planes;
}

/** Hook de POST/PATCH depósitos: asienta las etapas que falten en el libro. */
export async function asentarDeposito(
  tx: Db,
  deposito: DepositoParaAsiento,
  opts: { ctx?: ContextoAsientos; rango?: { desde: Date; hasta: Date }; ahora?: Date } = {}
): Promise<number> {
  const c = opts.ctx ?? (await contextoAsientos(tx, deposito.companyId));
  if (!c.config.activa) return 0;
  // La cancelación sólo se reversa si el recibido llegó al libro.
  const reversarCancelado =
    deposito.estado === "CANCELADO" && (await yaAsentado(tx, deposito.companyId, deposito.id, TIPO_ASIENTO.DEPOSITO_RECIBIDO));
  let n = 0;
  for (const plan of planesDeposito(deposito, { rango: opts.rango, ahora: opts.ahora, reversarCancelado })) {
    if (await ejecutarPlan(tx, c, plan, opts.ahora)) n++;
  }
  return n;
}

// ─── Mes: previsualizar y asentar lo pendiente ───────────────────────────────

export function rangoMesUtc(anio: number, mes: number): { desde: Date; hasta: Date } {
  return { desde: new Date(Date.UTC(anio, mes - 1, 1)), hasta: new Date(Date.UTC(anio, mes, 1)) };
}

/** `?anio=&mes=` de las rutas de contabilidad; default el mes UTC en curso (el del libro). Null si no es válido. */
export function periodoDeQuery(searchParams: URLSearchParams, hoy: Date = new Date()): { anio: number; mes: number } | null {
  const anio = Number(searchParams.get("anio") || hoy.getUTCFullYear());
  const mes = Number(searchParams.get("mes") || hoy.getUTCMonth() + 1);
  if (!Number.isInteger(anio) || anio < 2000 || anio > 2100 || !Number.isInteger(mes) || mes < 1 || mes > 12) return null;
  return { anio, mes };
}

/** Todo lo del mes que tocaría el libro con fuente HOSPITAL, esté o no asentado ya. */
export async function planesDelMes(db: Db, companyId: string, anio: number, mes: number, ctx: ContextoAsientos, ahora: Date = new Date()): Promise<AsientoPlan[]> {
  const rango = rangoMesUtc(anio, mes);
  const [movimientos, cargos, depositos] = await Promise.all([
    db.hospMovimientoInsumo.findMany({
      where: { companyId, tipo: "SALIDA_APLICACION", asientoAt: null, fecha: { gte: rango.desde, lt: rango.hasta } },
      select: {
        id: true,
        companyId: true,
        tipo: true,
        cantidad: true,
        costoUnitario: true,
        fecha: true,
        asientoAt: true,
        insumo: { select: { nombre: true } },
        lote: { select: { lote: true } },
      },
      orderBy: { fecha: "asc" },
    }),
    db.hospCargo.findMany({
      where: {
        companyId,
        categoria: "HONORARIO",
        cancelado: false,
        asientoAt: null,
        medicoId: { not: null },
        episodio: { estado: "ALTA", fechaAlta: { gte: rango.desde, lt: rango.hasta } },
      },
      select: {
        id: true,
        medicoId: true,
        importe: true,
        ivaTasa: true,
        asientoAt: true,
        medico: { select: { id: true, nombre: true, rfc: true, supplier: { select: { rfc: true } } } },
        episodio: { select: { id: true, folio: true, fechaAlta: true } },
      },
    }),
    db.hospDeposito.findMany({
      where: {
        companyId,
        estado: { not: "CANCELADO" },
        OR: [
          { fecha: { gte: rango.desde, lt: rango.hasta } },
          { aplicadoAt: { gte: rango.desde, lt: rango.hasta } },
          { devueltoAt: { gte: rango.desde, lt: rango.hasta } },
        ],
      },
      include: { episodio: { select: { folio: true } } },
      orderBy: { fecha: "asc" },
    }),
  ]);

  const planes: AsientoPlan[] = [];
  for (const m of movimientos) {
    const plan = planSalidaFarmacia({ ...m, descripcion: `${m.insumo.nombre}${m.lote ? ` · lote ${m.lote.lote}` : ""}` });
    if (plan) planes.push(plan);
  }
  const porEpisodio = new Map<string, { episodio: { id: string; folio: string; fechaAlta: Date | null }; cargos: CargoHonorario[] }>();
  for (const c of cargos) {
    const grupo = porEpisodio.get(c.episodio.id) ?? { episodio: c.episodio, cargos: [] };
    grupo.cargos.push(c);
    porEpisodio.set(c.episodio.id, grupo);
  }
  for (const g of porEpisodio.values()) planes.push(...planesHonorarios(g.episodio, g.cargos, ctx.config.empresaRetiene, ahora));
  for (const d of depositos) planes.push(...planesDeposito({ ...d, folio: d.episodio.folio }, { rango, ahora }));
  return planes.sort((a, b) => a.fecha.getTime() - b.fecha.getTime());
}

export interface AsientoPrevisto {
  fecha: Date;
  descripcion: string;
  monto: number;
  referencia: string;
  referenciaTipo: string;
  cargo: { clave: ClaveMotor | null; codigo: string | null; nombre: string | null };
  abono: { clave: ClaveMotor | null; codigo: string | null; nombre: string | null };
  asentado: boolean;
}

/**
 * Lo que el mes tiene con fuente HOSPITAL: lo pendiente (calculado hoy) y lo
 * que ya está en el libro. Sirve aunque la contabilidad esté apagada: es la
 * previsualización con la que el contador decide activarla.
 */
export async function previewMes(db: Db, companyId: string, anio: number, mes: number): Promise<{ activa: boolean; asientos: AsientoPrevisto[] }> {
  const ctx = await contextoAsientos(db, companyId);
  const [planes, mapa, filas] = await Promise.all([
    planesDelMes(db, companyId, anio, mes, ctx),
    mapaCuentas(db, companyId),
    db.accountingEntry.findMany({
      where: { companyId, fuente: FUENTE_HOSPITAL, year: anio, month: mes },
      select: {
        fecha: true,
        descripcion: true,
        monto: true,
        referencia: true,
        referenciaTipo: true,
        tipo: true,
        chartAccount: { select: { cuentaSAT: true, subcuenta: true, nombre: true } },
      },
      orderBy: { fecha: "asc" },
    }),
  ]);

  // Lo asentado se arma por pares (referencia + tipo).
  const asentados = new Map<string, AsientoPrevisto>();
  for (const f of filas) {
    const llave = `${f.referencia ?? ""}|${f.referenciaTipo ?? ""}`;
    const a = asentados.get(llave) ?? {
      fecha: f.fecha,
      descripcion: f.descripcion,
      monto: r2(Number(f.monto)),
      referencia: f.referencia ?? "",
      referenciaTipo: f.referenciaTipo ?? "",
      cargo: { clave: null, codigo: null, nombre: null },
      abono: { clave: null, codigo: null, nombre: null },
      asentado: true,
    };
    const lado = { clave: null, codigo: codigoDeCuenta(f.chartAccount), nombre: f.chartAccount.nombre };
    if (f.tipo === "CARGO") a.cargo = lado;
    else a.abono = lado;
    asentados.set(llave, a);
  }

  // Sin crear cuentas: la previsualización sólo mira el mapa (la cuenta que
  // hoy existe o, si aún no, el código con el que se crearía al asentar).
  const porClave = new Map(mapa.claves.map((r) => [r.clave, r]));
  const lado = (clave: ClaveMotor) => {
    const r = porClave.get(clave);
    return { clave, codigo: r?.cuenta?.codigo ?? r?.subcuenta ?? r?.cuentaSAT ?? null, nombre: r?.cuenta?.nombre ?? null };
  };
  const pendientes: AsientoPrevisto[] = [];
  for (const p of planes) {
    if (asentados.has(`${p.referencia}|${p.referenciaTipo}`)) continue;
    pendientes.push({
      fecha: p.fecha,
      descripcion: p.descripcion,
      monto: p.monto,
      referencia: p.referencia,
      referenciaTipo: p.referenciaTipo,
      cargo: lado(p.cargo),
      abono: lado(p.abono),
      asentado: false,
    });
  }
  return { activa: ctx.config.activa, asientos: [...pendientes, ...asentados.values()].sort((a, b) => a.fecha.getTime() - b.fecha.getTime()) };
}

/** POST /contabilidad/asentar: lo pendiente del mes, en una transacción. Idempotente. */
export async function asentarMes(db: PrismaClient, companyId: string, anio: number, mes: number): Promise<{ asentados: number; revisados: number }> {
  return db.$transaction(async (tx) => {
    const ctx = await contextoAsientos(tx, companyId);
    if (!ctx.config.activa) throw new HospitalError(409, "La contabilidad del hospital no está activa: actívala en el mapa de cuentas tras la apertura");
    const planes = await planesDelMes(tx, companyId, anio, mes, ctx);
    let asentados = 0;
    for (const plan of planes) if (await ejecutarPlan(tx, ctx, plan)) asentados++;
    return { asentados, revisados: planes.length };
  });
}
