// ─────────────────────────────────────────────────────────────────────────────
// Consultas de `aplicaciones`: junta las filas y se las da a la decisión pura.
// Dos entradas —por movimiento y por factura— y una sola forma de leer la
// misma relación. Sin auth: el llamador ya validó la membresía; aquí sólo se
// acota por companyId para que un id ajeno devuelva null, nunca datos.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { normalizarUuid, variantesUuid } from "@/lib/fiscal/uuid";
import { etiquetaImpuesto } from "@/lib/conciliacion-impuestos";
import {
  resumirFactura,
  resumirMovimiento,
  type CuentaLigera,
  type FacturaLigera,
  type LineaRep,
  type MovimientoLigero,
  type ResumenFactura,
  type ResumenMovimiento,
} from "./aplicaciones";

const SELECT_FACTURA = {
  id: true, uuid: true, serie: true, folio: true, fecha: true, total: true, tipo: true, metodoPago: true,
  contraparteNombre: true, contraparteRfc: true,
  customer: { select: { razonSocial: true, rfc: true } },
} as const;

const SELECT_CUENTA = { id: true, banco: true, nombre: true, numeroCuenta: true } as const;

const SELECT_MOVIMIENTO = {
  id: true, fecha: true, descripcion: true, monto: true, status: true,
  contraparteNombre: true, contraparteRfc: true, claveRastreo: true,
  bankAccount: { select: SELECT_CUENTA },
} as const;

type FacturaRow = {
  id: string; uuid: string | null; serie: string | null; folio: string | null; fecha: Date;
  total: { toString(): string } | number; tipo: string; metodoPago: string;
  contraparteNombre: string | null; contraparteRfc: string | null;
  customer: { razonSocial: string; rfc: string } | null;
};
type MovimientoRow = {
  id: string; fecha: Date; descripcion: string; monto: { toString(): string } | number; status: string;
  contraparteNombre: string | null; contraparteRfc: string | null; claveRastreo: string | null;
  bankAccount: CuentaLigera;
};

function facturaLigera(f: FacturaRow): FacturaLigera {
  return {
    id: f.id, uuid: f.uuid, serie: f.serie, folio: f.folio, fecha: f.fecha, total: Number(f.total), tipo: f.tipo,
    metodoPago: f.metodoPago,
    // El Customer manda cuando existe; si no, lo que trae el propio CFDI.
    contraparteNombre: f.customer?.razonSocial ?? f.contraparteNombre,
    contraparteRfc: f.customer?.rfc ?? f.contraparteRfc,
  };
}

function movimientoLigero(m: MovimientoRow): MovimientoLigero {
  return {
    id: m.id, fecha: m.fecha, descripcion: m.descripcion, monto: Number(m.monto),
    status: m.status as MovimientoLigero["status"],
    cuenta: m.bankAccount,
    contraparteNombre: m.contraparteNombre, contraparteRfc: m.contraparteRfc, claveRastreo: m.claveRastreo,
  };
}

/** Líneas de REP que apuntan a estas facturas, agrupadas por UUID normalizado. */
async function lineasRepPorFactura(uuids: Array<string | null>): Promise<Map<string, LineaRep[]>> {
  const limpios = uuids.filter((u): u is string => !!u);
  const out = new Map<string, LineaRep[]>();
  if (limpios.length === 0) return out;
  const filas = await prisma.pagoDoctoRelacionado.findMany({
    where: { parentUuid: { in: variantesUuid(limpios) } },
    select: {
      id: true, parentUuid: true, numParcialidad: true, impPagado: true, impSaldoInsoluto: true, fechaPago: true,
      pagoInvoice: { select: { uuid: true } },
    },
  });
  for (const r of filas) {
    const k = normalizarUuid(r.parentUuid);
    const linea: LineaRep = {
      id: r.id,
      repUuid: r.pagoInvoice.uuid,
      numParcialidad: r.numParcialidad,
      impPagado: r.impPagado == null ? null : Number(r.impPagado),
      impSaldoInsoluto: r.impSaldoInsoluto == null ? null : Number(r.impSaldoInsoluto),
      fechaPago: r.fechaPago,
    };
    out.set(k, [...(out.get(k) ?? []), linea]);
  }
  return out;
}

/** Todo lo que se sabe de un movimiento: original, CEP, aplicado, restante, aplicaciones y su REP. */
export async function aplicacionesDeMovimiento(txId: string, companyId: string): Promise<ResumenMovimiento | null> {
  const tx = await prisma.bankTransaction.findFirst({
    where: { id: txId, companyId },
    select: {
      ...SELECT_MOVIMIENTO,
      invoice: { select: SELECT_FACTURA },
      conciliacionDetalles: {
        select: { id: true, montoAsignado: true, createdAt: true, invoice: { select: SELECT_FACTURA } },
        orderBy: { createdAt: "asc" },
      },
      cepMovimiento: {
        select: {
          estado: true, fechaOperacion: true, concepto: true, monto: true,
          ordenanteNombre: true, ordenanteRfc: true, ordenanteBanco: true, ordenanteCuenta: true,
          beneficiarioNombre: true, beneficiarioRfc: true, beneficiarioBanco: true, beneficiarioCuenta: true,
        },
      },
      taxDeclaration: { select: { id: true, tipo: true, periodo: true, status: true } },
    },
  });
  if (!tx) return null;

  const facturaUnoAUno = tx.invoice ? facturaLigera(tx.invoice) : null;
  const porciones = tx.conciliacionDetalles.map((d) => ({
    id: d.id,
    montoAsignado: Number(d.montoAsignado),
    createdAt: d.createdAt,
    factura: facturaLigera(d.invoice),
  }));
  const repsPorFactura = await lineasRepPorFactura([
    facturaUnoAUno?.uuid ?? null,
    ...porciones.map((p) => p.factura.uuid),
  ]);

  return resumirMovimiento({
    movimiento: movimientoLigero(tx),
    cep: tx.cepMovimiento
      ? { ...tx.cepMovimiento, monto: tx.cepMovimiento.monto == null ? null : Number(tx.cepMovimiento.monto) }
      : null,
    facturaUnoAUno,
    porciones,
    repsPorFactura,
    impuesto: tx.taxDeclaration
      ? { id: tx.taxDeclaration.id, etiqueta: etiquetaImpuesto(tx.taxDeclaration.tipo, tx.taxDeclaration.periodo), status: tx.taxDeclaration.status }
      : null,
  });
}

/** Todo lo que se sabe de una factura: total, aplicado, disponible, aplicaciones y su REP. */
export async function aplicacionesDeFactura(invoiceId: string, companyId: string): Promise<ResumenFactura | null> {
  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId, companyId },
    select: {
      ...SELECT_FACTURA,
      bankTransactions: { where: { status: "MATCHED" }, select: SELECT_MOVIMIENTO },
      conciliacionDetalles: {
        select: { id: true, montoAsignado: true, createdAt: true, bankTransaction: { select: SELECT_MOVIMIENTO } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!inv) return null;

  const factura = facturaLigera(inv);
  const reps = await lineasRepPorFactura([factura.uuid]);
  return resumirFactura({
    factura,
    unoAUno: inv.bankTransactions.map(movimientoLigero),
    porciones: inv.conciliacionDetalles.map((d) => ({
      id: d.id,
      montoAsignado: Number(d.montoAsignado),
      createdAt: d.createdAt,
      movimiento: movimientoLigero(d.bankTransaction),
    })),
    lineasRep: factura.uuid ? reps.get(factura.uuid.toUpperCase()) ?? [] : [],
  });
}
