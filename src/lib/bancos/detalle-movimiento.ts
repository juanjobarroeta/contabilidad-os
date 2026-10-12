// ─────────────────────────────────────────────────────────────────────────────
// EL DETALLE DE UN MOVIMIENTO BANCARIO, EN UNA SOLA LLAMADA.
//
// Lo que la ventana del movimiento necesita para contestar «¿qué es esto y con
// qué quedó amarrado?» sin cinco viajes: la cuenta, la contraparte (la del
// estado de cuenta y la del CEP de Banxico), cada factura con lo que ESTE
// movimiento le aplicó y lo que le queda por pagar, los REP de esas facturas,
// el impuesto si fue un pago al SAT, la liquidación de terminal con sus cobros
// de caja, y el rastro de decisiones (motores y personas).
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { pagosConciliadosPorInvoice } from "@/lib/fiscal/conciliacion-pue";
import { REP_VIGENTE } from "@/lib/fiscal/rep-vigente";
import { normalizarUuid, variantesUuid } from "@/lib/fiscal/uuid";
import { historiaDeMovimiento, type EventoHistoria } from "@/lib/bancos/historia-movimiento";

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface FacturaDelMovimiento {
  id: string;
  uuid: string | null;
  serie: string | null;
  folio: string | null;
  fecha: Date;
  tipo: string;
  tipoSat: string | null;
  metodoPago: string;
  status: string;
  /** Quién la emite y quién la recibe (la empresa es uno de los dos). */
  emisor: { nombre: string | null; rfc: string | null };
  receptor: { nombre: string | null; rfc: string | null };
  total: number;
  /** Lo que ESTE movimiento le aplicó. */
  aplicado: number;
  /** Lo pagado por banco entre todos sus movimientos conciliados. */
  pagadoPorBanco: number;
  /** total − pagadoPorBanco, nunca negativo. */
  saldo: number;
  /** El reparto viene de una porción (ConciliacionDetalle) y no del vínculo 1:1. */
  porcion: boolean;
  reps: { uuid: string | null; fechaPago: Date | null; impPagado: number | null; parcialidad: number | null }[];
}

export interface DetalleMovimiento {
  movimiento: {
    id: string;
    fecha: Date;
    monto: number;
    saldo: number | null;
    tipo: string;
    descripcion: string;
    referencia: string | null;
    claveRastreo: string | null;
    conceptoPago: string | null;
    lineaCaptura: string | null;
    status: string;
    notes: string | null;
    source: string;
    contraparte: { nombre: string | null; rfc: string | null; clabe: string | null; banco: string | null };
  };
  cuenta: { id: string; banco: string; nombre: string | null; numeroCuenta: string; clabe: string | null } | null;
  cep: {
    estado: string | null;
    fechaOperacion: string | null;
    concepto: string | null;
    monto: number | null;
    ordenante: { nombre: string | null; rfc: string | null; cuenta: string | null; banco: string | null };
    beneficiario: { nombre: string | null; rfc: string | null; cuenta: string | null; banco: string | null };
  } | null;
  facturas: FacturaDelMovimiento[];
  /** Lo que el movimiento todavía no tiene asignado a factura (anticipo, sobrante). */
  sinAsignar: number;
  impuesto: { id: string; tipo: string; periodo: string; status: string } | null;
  liquidacion: {
    id: string;
    fecha: Date;
    bruto: number;
    comision: number;
    ivaComision: number;
    neto: number;
    terminal: string | null;
    cobros: { id: string; fecha: Date; monto: number; formaPago: string; estado: string; autorizacion: string | null; ultimos4: string | null }[];
  } | null;
  devolucion: { de: { id: string; fecha: Date; monto: number; descripcion: string } | null; por: { id: string; fecha: Date; monto: number; descripcion: string } | null };
  comisionDe: { id: string; fecha: Date; monto: number; descripcion: string } | null;
  comisiones: { id: string; monto: number; descripcion: string }[];
  historia: EventoHistoria[];
}

const SELECT_FACTURA = {
  id: true, uuid: true, serie: true, folio: true, fecha: true, tipo: true, tipoSat: true, metodoPago: true, status: true, total: true,
  contraparteNombre: true, contraparteRfc: true,
  customer: { select: { razonSocial: true, rfc: true } },
  company: { select: { razonSocial: true, rfc: true } },
} as const;

/** El detalle, o null si el movimiento no existe. La autorización la hace la ruta. */
export async function detalleMovimiento(txId: string): Promise<DetalleMovimiento | null> {
  const tx = await prisma.bankTransaction.findUnique({
    where: { id: txId },
    include: {
      bankAccount: { select: { id: true, banco: true, nombre: true, numeroCuenta: true, clabe: true } },
      invoice: { select: SELECT_FACTURA },
      conciliacionDetalles: { select: { montoAsignado: true, invoice: { select: SELECT_FACTURA } } },
      taxDeclaration: { select: { id: true, tipo: true, periodo: true, status: true } },
      devolucionDe: { select: { id: true, fecha: true, monto: true, descripcion: true } },
      devolucionPor: { select: { id: true, fecha: true, monto: true, descripcion: true } },
      comisionDe: { select: { id: true, fecha: true, monto: true, descripcion: true } },
      comisiones: { select: { id: true, monto: true, descripcion: true } },
    },
  });
  if (!tx) return null;

  const monto = Number(tx.monto);
  type F = NonNullable<typeof tx.invoice>;
  const ligadas: { f: F; aplicado: number; porcion: boolean }[] = [];
  if (tx.invoice) ligadas.push({ f: tx.invoice, aplicado: Math.abs(monto), porcion: false });
  // Las porciones sólo cuentan si el movimiento no tiene vínculo 1:1 (misma
  // regla que el posteo y el estado de cuenta: si no, un cobro contaría doble).
  if (!tx.invoiceId) for (const d of tx.conciliacionDetalles) ligadas.push({ f: d.invoice, aplicado: Math.abs(Number(d.montoAsignado)), porcion: true });

  const ids = ligadas.map((l) => l.f.id);
  const uuids = ligadas.map((l) => l.f.uuid).filter((u): u is string => !!u);
  const [pagados, reps, cep, liquidacion, historia] = await Promise.all([
    pagosConciliadosPorInvoice(ids),
    uuids.length
      ? prisma.pagoDoctoRelacionado.findMany({
          where: { parentUuid: { in: variantesUuid(uuids) }, pagoInvoice: { companyId: tx.companyId, ...REP_VIGENTE } },
          select: { parentUuid: true, fechaPago: true, impPagado: true, numParcialidad: true, pagoInvoice: { select: { uuid: true } } },
          orderBy: { fechaPago: "asc" },
        })
      : [],
    prisma.cepMovimiento.findUnique({ where: { bankTransactionId: txId } }),
    prisma.hospLiquidacion.findUnique({
      where: { bankTransactionId: txId },
      include: {
        afiliacion: { select: { numero: true, adquirente: true, descripcion: true } },
        cobros: { select: { id: true, fecha: true, monto: true, formaPago: true, estado: true, autorizacion: true, ultimos4: true }, orderBy: { fecha: "asc" } },
      },
    }).catch(() => null),
    historiaDeMovimiento(tx.companyId, txId),
  ]);

  const repsPorPadre = new Map<string, typeof reps>();
  for (const r of reps) {
    const k = normalizarUuid(r.parentUuid);
    repsPorPadre.set(k, [...(repsPorPadre.get(k) ?? []), r]);
  }

  const facturas: FacturaDelMovimiento[] = ligadas.map(({ f, aplicado, porcion }) => {
    const total = Number(f.total);
    const pagado = pagados.get(f.id) ?? 0;
    const propia = { nombre: f.company.razonSocial, rfc: f.company.rfc };
    const otra = { nombre: f.customer?.razonSocial ?? f.contraparteNombre, rfc: f.customer?.rfc ?? f.contraparteRfc };
    // INGRESO: la emite la empresa. EGRESO: la emite el proveedor.
    const emiteLaEmpresa = f.tipo !== "EGRESO";
    return {
      id: f.id, uuid: f.uuid, serie: f.serie, folio: f.folio, fecha: f.fecha, tipo: f.tipo, tipoSat: f.tipoSat, metodoPago: f.metodoPago, status: f.status,
      emisor: emiteLaEmpresa ? propia : otra,
      receptor: emiteLaEmpresa ? otra : propia,
      total: r2(total),
      aplicado: r2(aplicado),
      pagadoPorBanco: r2(pagado),
      saldo: r2(Math.max(0, total - pagado)),
      porcion,
      reps: (f.uuid ? repsPorPadre.get(normalizarUuid(f.uuid)) ?? [] : []).map((r) => ({
        uuid: r.pagoInvoice?.uuid ?? null,
        fechaPago: r.fechaPago,
        impPagado: r.impPagado == null ? null : Number(r.impPagado),
        parcialidad: r.numParcialidad,
      })),
    };
  });
  const asignado = facturas.reduce((a, f) => a + f.aplicado, 0);

  return {
    movimiento: {
      id: tx.id, fecha: tx.fecha, monto, saldo: tx.saldo == null ? null : Number(tx.saldo), tipo: tx.tipo,
      descripcion: tx.descripcion, referencia: tx.referencia, claveRastreo: tx.claveRastreo, conceptoPago: tx.conceptoPago,
      lineaCaptura: tx.lineaCaptura, status: tx.status, notes: tx.notes, source: tx.source,
      contraparte: { nombre: tx.contraparteNombre, rfc: tx.contraparteRfc, clabe: tx.contraparteClabe, banco: tx.contraparteBanco },
    },
    cuenta: tx.bankAccount,
    cep: cep
      ? {
          estado: cep.estado, fechaOperacion: cep.fechaOperacion, concepto: cep.concepto, monto: cep.monto == null ? null : Number(cep.monto),
          ordenante: { nombre: cep.ordenanteNombre, rfc: cep.ordenanteRfc, cuenta: cep.ordenanteCuenta, banco: cep.ordenanteBanco },
          beneficiario: { nombre: cep.beneficiarioNombre, rfc: cep.beneficiarioRfc, cuenta: cep.beneficiarioCuenta, banco: cep.beneficiarioBanco },
        }
      : null,
    facturas,
    sinAsignar: tx.status === "MATCHED" && facturas.length ? r2(Math.max(0, Math.abs(monto) - asignado)) : 0,
    impuesto: tx.taxDeclaration,
    liquidacion: liquidacion
      ? {
          id: liquidacion.id, fecha: liquidacion.fecha, bruto: Number(liquidacion.bruto), comision: Number(liquidacion.comision),
          ivaComision: Number(liquidacion.ivaComision), neto: Number(liquidacion.neto), terminal: [liquidacion.afiliacion?.adquirente, liquidacion.afiliacion?.descripcion, liquidacion.afiliacion?.numero && `afiliación ${liquidacion.afiliacion.numero}`].filter(Boolean).join(" · ") || null,
          cobros: liquidacion.cobros.map((c) => ({ ...c, monto: Number(c.monto) })),
        }
      : null,
    devolucion: {
      de: tx.devolucionDe ? { ...tx.devolucionDe, monto: Number(tx.devolucionDe.monto) } : null,
      por: tx.devolucionPor ? { ...tx.devolucionPor, monto: Number(tx.devolucionPor.monto) } : null,
    },
    comisionDe: tx.comisionDe ? { ...tx.comisionDe, monto: Number(tx.comisionDe.monto) } : null,
    comisiones: tx.comisiones.map((c) => ({ ...c, monto: Number(c.monto) })),
    historia,
  };
}
