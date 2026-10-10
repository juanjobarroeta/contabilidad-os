// ─────────────────────────────────────────────────────────────────────────────
// Flujo de efectivo proyectado del hospital, por semana.
//
//   saldo inicial = último saldo que reporta el banco por cuenta (el corte
//                   cargado más reciente; no el de libros)
//   + entradas    = facturas emitidas con saldo, a su fecha esperada de cobro
//                   (fecha + plazo del convenio del cliente; sin convenio, 30 d)
//   − salidas     = órdenes de compra con saldo, a su fecha programada o su
//                   vencimiento; facturas de proveedor con saldo que no
//                   pertenecen a ninguna orden (fecha + 30 d); y la nómina
//                   estimada con la última corrida ordinaria y su periodicidad.
//
// Lo ya vencido (cobros atrasados, pagos atrasados) cae en la primera semana:
// es dinero que se espera ya. Sin presupuestos (decisión del hospital) y sin
// impuestos: el pago de impuestos del mes se ve en Impuestos, no aquí.
// Mismo criterio de «pagado» que Cartera y Compras (cobranza.ts).
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma, PrismaClient } from "@prisma/client";
import { amparadoDe, amparadoPorReps, conciliadoDe, pagadoPorEvidencia } from "./cobranza";
import { ordenesDeCompra, VINCULO_ORDEN } from "./requisiciones";

type Db = PrismaClient | Prisma.TransactionClient;

const r2 = (n: number) => Math.round(n * 100) / 100;
const DIA = 86_400_000;
export const PLAZO_DEFAULT_DIAS = 30;

export interface SemanaFlujo {
  desde: Date;
  hasta: Date;
  entradas: number;
  salidas: { ordenes: number; sinOrden: number; nomina: number; total: number };
  neto: number;
  saldoFinal: number;
}

/** Índice de semana (0 = la actual, que también recoge lo vencido); null si cae fuera del horizonte. */
export function semanaDe(fecha: Date, inicio: Date, semanas: number): number | null {
  const i = Math.floor((fecha.getTime() - inicio.getTime()) / (7 * DIA));
  if (i < 0) return 0;
  return i < semanas ? i : null;
}

/** Fechas de pago de nómina dentro del horizonte, a partir de las dos últimas corridas ordinarias. */
export function fechasNomina(ultimas: Date[], hasta: Date): Date[] {
  if (ultimas.length === 0) return [];
  const [ultima, previa] = [...ultimas].sort((a, b) => b.getTime() - a.getTime());
  // Sin una segunda corrida, se asume quincenal.
  const paso = previa ? Math.max(7, Math.round((ultima.getTime() - previa.getTime()) / DIA)) : 15;
  const out: Date[] = [];
  for (let f = new Date(ultima.getTime() + paso * DIA); f <= hasta; f = new Date(f.getTime() + paso * DIA)) out.push(f);
  return out;
}

export async function flujoEfectivo(db: Db, companyId: string, semanas = 8, hoy = new Date()) {
  const inicio = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - ((hoy.getDay() + 6) % 7)); // lunes
  const fin = new Date(inicio.getTime() + semanas * 7 * DIA);

  const [cuentas, ingresos, egresos, pagadores, corridas, vinculadas] = await Promise.all([
    db.bankAccount.findMany({
      where: { companyId },
      select: { id: true, nombre: true, banco: true, transactions: { where: { saldo: { not: null } }, select: { saldo: true, fecha: true }, orderBy: [{ fecha: "desc" }, { createdAt: "desc" }], take: 1 } },
    }),
    db.invoice.findMany({
      where: { companyId, tipo: "INGRESO", status: { not: "CANCELLED" }, NOT: { tipoSat: "E" } },
      select: { uuid: true, total: true, metodoPago: true, fecha: true, customerId: true, conciliacionDetalles: { select: { montoAsignado: true } } },
    }),
    db.invoice.findMany({
      where: { companyId, tipo: "EGRESO", status: { not: "CANCELLED" }, NOT: { tipoSat: "E" } },
      select: { id: true, uuid: true, total: true, metodoPago: true, fecha: true, conciliacionDetalles: { select: { montoAsignado: true } } },
    }),
    db.hospPagador.findMany({ where: { companyId, customerId: { not: null } }, select: { customerId: true, plazoDias: true } }),
    db.payrollRun.findMany({
      where: { companyId, tipo: "ORDINARIA", status: { not: "DRAFT" } },
      select: { fechaPago: true, totalNeto: true },
      orderBy: { fechaPago: "desc" },
      take: 2,
    }),
    db.construccionCfdiVinculo.findMany({ where: { companyId, targetTipo: VINCULO_ORDEN }, select: { invoiceId: true } }),
  ]);

  const saldoInicial = r2(cuentas.reduce((s, c) => s + Number(c.transactions[0]?.saldo ?? 0), 0));
  const plazoDe = new Map<string, number>();
  for (const p of pagadores) if (p.customerId && p.plazoDias != null) plazoDe.set(p.customerId, p.plazoDias);

  const vacias = (): SemanaFlujo[] =>
    Array.from({ length: semanas }, (_, i) => ({
      desde: new Date(inicio.getTime() + i * 7 * DIA),
      hasta: new Date(inicio.getTime() + (i + 1) * 7 * DIA),
      entradas: 0,
      salidas: { ordenes: 0, sinOrden: 0, nomina: 0, total: 0 },
      neto: 0,
      saldoFinal: 0,
    }));
  const s = vacias();

  // Entradas: lo que falta por cobrar de cada factura emitida.
  const ampIng = await amparadoPorReps(db, companyId, ingresos.map((f) => f.uuid));
  let porCobrarVencido = 0;
  for (const f of ingresos) {
    const ev = pagadoPorEvidencia({ metodoPago: f.metodoPago, total: Number(f.total), conciliado: conciliadoDe(f.conciliacionDetalles), amparadoRep: amparadoDe(ampIng, f.uuid) });
    if (ev.saldo <= 0.01) continue;
    const esperada = new Date(f.fecha.getTime() + (plazoDe.get(f.customerId ?? "") ?? PLAZO_DEFAULT_DIAS) * DIA);
    const i = semanaDe(esperada, inicio, semanas);
    if (i == null) continue;
    if (esperada < inicio) porCobrarVencido += ev.saldo;
    s[i].entradas += ev.saldo;
  }

  // Salidas 1: órdenes de compra con saldo.
  const ordenes = await ordenesDeCompra(db, companyId, { soloAbiertas: true }, hoy);
  for (const o of ordenes) {
    const cuando = o.autorizacionPago?.fechaProgramada ?? o.vencimiento ?? hoy;
    const i = semanaDe(new Date(cuando), inicio, semanas);
    if (i != null) s[i].salidas.ordenes += o.pago.saldo;
  }

  // Salidas 2: facturas de proveedor con saldo que no son de ninguna orden.
  const ligadas = new Set(vinculadas.map((v) => v.invoiceId));
  const ampEgr = await amparadoPorReps(db, companyId, egresos.map((f) => f.uuid));
  for (const f of egresos) {
    if (ligadas.has(f.id)) continue;
    const ev = pagadoPorEvidencia({ metodoPago: f.metodoPago, total: Number(f.total), conciliado: conciliadoDe(f.conciliacionDetalles), amparadoRep: amparadoDe(ampEgr, f.uuid) });
    if (ev.saldo <= 0.01) continue;
    const i = semanaDe(new Date(f.fecha.getTime() + PLAZO_DEFAULT_DIAS * DIA), inicio, semanas);
    if (i != null) s[i].salidas.sinOrden += ev.saldo;
  }

  // Salidas 3: nómina estimada (neto de la última corrida ordinaria).
  const netoNomina = corridas[0] ? Number(corridas[0].totalNeto) : 0;
  const pagosNomina = netoNomina > 0 ? fechasNomina(corridas.map((c) => c.fechaPago), fin) : [];
  for (const f of pagosNomina) {
    if (f < inicio) continue;
    const i = semanaDe(f, inicio, semanas);
    if (i != null) s[i].salidas.nomina += netoNomina;
  }

  let saldo = saldoInicial;
  for (const w of s) {
    w.entradas = r2(w.entradas);
    w.salidas.ordenes = r2(w.salidas.ordenes);
    w.salidas.sinOrden = r2(w.salidas.sinOrden);
    w.salidas.nomina = r2(w.salidas.nomina);
    w.salidas.total = r2(w.salidas.ordenes + w.salidas.sinOrden + w.salidas.nomina);
    w.neto = r2(w.entradas - w.salidas.total);
    saldo = r2(saldo + w.neto);
    w.saldoFinal = saldo;
  }

  return {
    saldoInicial,
    cuentas: cuentas.map((c) => ({ id: c.id, nombre: c.nombre, banco: c.banco, saldo: c.transactions[0]?.saldo != null ? Number(c.transactions[0].saldo) : null, al: c.transactions[0]?.fecha ?? null })),
    porCobrarVencido: r2(porCobrarVencido),
    nominaEstimada: netoNomina > 0 ? { neto: r2(netoNomina), pagos: pagosNomina.length } : null,
    semanas: s,
    primeraSemanaNegativa: s.find((w) => w.saldoFinal < 0)?.desde ?? null,
  };
}
