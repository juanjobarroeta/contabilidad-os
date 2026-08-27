// ─────────────────────────────────────────────────────────────────────────────
// Cobros bancarios conciliados a facturas PPD EMITIDAS sin complemento de pago
// (REP) que los ampare. El banco dice que se cobró; los CFDI no: el motor de
// IVA en flujo (Art. 1-B LIVA) sólo causa el IVA de un PPD cuando existe el
// REP, así que un cobro sin complemento SUBDECLARA IVA trasladado — y además
// incumple la obligación de emitir el REP (RMF 2.7.1.32: a más tardar el
// quinto día natural del mes siguiente al cobro). Caso real: una empresa cobró
// $45,860 de facturas de meses anteriores sin emitir complementos y su IVA del
// mes salió ~$7,338 abajo del cálculo del contador.
//
// Señal por factura: lo conciliado en banco (ConciliacionDetalle de abonos)
// menos lo amparado por REPs (PagoDoctoRelacionado.impPagado). Un hallazgo
// AGREGADO por empresa (dedupeRef estable), como los demás checks de banco.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { normalizarUuid, variantesUuid } from "@/lib/fiscal/uuid";
import type { Hallazgo } from "./types";

/** Tolerancia en pesos para no reportar residuos de centavos/comisiones. */
export const TOLERANCIA_MONTO = 1;

export interface CobroSinRep {
  invoiceId: string;
  folio: string | null;
  /** Cobrado en banco (suma de porciones conciliadas de ABONOS). */
  cobradoBanco: number;
  /** Amparado por complementos de pago (suma de ImpPagado hacia la factura). */
  amparadoRep: number;
  /** Cobrado sin REP = cobradoBanco − amparadoRep (> tolerancia). */
  sinRep: number;
  /** IVA trasladado de la factura prorrateado a la porción sin REP. */
  ivaEstimado: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

const fmt = (n: number) =>
  "$" + n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Carga las facturas INGRESO PPD vigentes con cobros conciliados y compara
 * contra los REPs que las amparan. Sólo cobros del ejercicio en curso (los
 * rezagos históricos se atienden aparte, no como ruido permanente).
 */
export async function cargarCobrosSinRep(companyId: string, hoy: Date): Promise<CobroSinRep[]> {
  const inicioEjercicio = new Date(Date.UTC(hoy.getUTCFullYear(), 0, 1));

  const facturas = await prisma.invoice.findMany({
    where: {
      companyId,
      tipo: "INGRESO",
      metodoPago: "PPD",
      status: "STAMPED",
      conciliacionDetalles: {
        some: { bankTransaction: { tipo: "CREDITO", fecha: { gte: inicioEjercicio } } },
      },
    },
    select: {
      id: true,
      uuid: true,
      folio: true,
      total: true,
      totalImpuestos: true,
      taxes: { select: { tipo: true, retencion: true, importe: true } },
      conciliacionDetalles: {
        where: { bankTransaction: { tipo: "CREDITO", fecha: { gte: inicioEjercicio } } },
        select: { montoAsignado: true },
      },
    },
  });
  if (facturas.length === 0) return [];

  // Empate por UUID normalizado (REP en MAYÚSCULAS vs PAC en minúsculas).
  const uuids = facturas.map((f) => f.uuid).filter(Boolean) as string[];
  const links = uuids.length
    ? await prisma.pagoDoctoRelacionado.findMany({
        where: { parentUuid: { in: variantesUuid(uuids) } },
        select: { parentUuid: true, impPagado: true },
      })
    : [];
  const amparadoPorUuid = new Map<string, number>();
  for (const l of links) {
    const k = normalizarUuid(l.parentUuid);
    amparadoPorUuid.set(k, (amparadoPorUuid.get(k) ?? 0) + (l.impPagado ?? 0));
  }

  const resultado: CobroSinRep[] = [];
  for (const f of facturas) {
    const cobradoBanco = f.conciliacionDetalles.reduce((s, d) => s + Math.abs(Number(d.montoAsignado)), 0);
    const amparadoRep = f.uuid ? (amparadoPorUuid.get(normalizarUuid(f.uuid)) ?? 0) : 0;
    const sinRep = cobradoBanco - amparadoRep;
    if (sinRep <= TOLERANCIA_MONTO) continue;
    const ivaFactura = (() => {
      const rows = f.taxes.filter((t) => t.tipo === "IVA" && !t.retencion);
      return rows.length > 0 ? rows.reduce((s, t) => s + t.importe, 0) : (f.totalImpuestos ?? 0);
    })();
    const ivaEstimado = f.total > 0 ? ivaFactura * (Math.min(sinRep, f.total) / f.total) : 0;
    resultado.push({
      invoiceId: f.id,
      folio: f.folio,
      cobradoBanco: r2(cobradoBanco),
      amparadoRep: r2(amparadoRep),
      sinRep: r2(sinRep),
      ivaEstimado: r2(ivaEstimado),
    });
  }
  return resultado;
}

/** Un hallazgo agregado por empresa (vacío → sin hallazgo). Puro. */
export function auditarCobrosSinRep(cobros: CobroSinRep[]): Hallazgo[] {
  if (cobros.length === 0) return [];
  const totalSinRep = r2(cobros.reduce((s, c) => s + c.sinRep, 0));
  const ivaTotal = r2(cobros.reduce((s, c) => s + c.ivaEstimado, 0));
  return [
    {
      checkClave: "cfdi.rep.faltante_cobro",
      dedupeRef: "cfdi.rep.faltante_cobro",
      severidad: "warn",
      mensaje: `${cobros.length} factura(s) PPD con cobros conciliados en banco por ${fmt(totalSinRep)} SIN complemento de pago (REP) que los ampare — IVA trasladado pendiente de causar ~${fmt(ivaTotal)}.`,
      referencias: cobros.map((c) => c.invoiceId),
      fundamento: { ley: "LIVA", articulo: "1-B" },
      sugerencia:
        "Emite el complemento de pago de cada cobro (obligatorio a más tardar el quinto día natural del mes siguiente al pago, RMF 2.7.1.32). El IVA de un PPD se causa al COBRO: mientras falte el REP, la declaración del mes va subdeclarada frente al banco y el cliente no puede acreditar su IVA.",
    },
  ];
}
