// ─────────────────────────────────────────────────────────────────────────────
// Complementos de pago (REP) desde el hospital (paso 4 de «Facturación desde
// el satélite»).
//
// Una factura PPD —la de la aseguradora o la empresa que paga a plazo— exige
// un complemento por cada pago recibido. El hub ya detecta lo cobrado por
// banco (lib/facturas/rep-pendientes.ts) y timbra el REP con la parcialidad y
// los saldos correctos (lib/complementos-rep-emit.ts). Aquí se agrega lo que
// sólo sabe el hospital: los COBROS de caja amarrados a la factura, que traen
// monto, fecha de operación y con qué se pagó — justo lo que pide el REP.
// ─────────────────────────────────────────────────────────────────────────────

import type { HospFormaPago, HospTarjetaTipo, Prisma, PrismaClient } from "@prisma/client";
import { normalizarUuid } from "@/lib/fiscal/uuid";
import { pendientesRep } from "@/lib/facturas/rep-pendientes";
import { amparadoPorReps, repsPorFactura } from "@/lib/facturas/reps-amparados";

type Db = PrismaClient | Prisma.TransactionClient;

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Cobros que sí son dinero recibido (no cancelados ni contracargados sin recuperar). */
export const ESTADOS_COBRO_VIGENTE = ["COBRADO", "DEPOSITADO", "RECUPERADO"] as const;

/** Forma de pago SAT (c_FormaPago) del cobro de caja. */
export function formaPagoSat(forma: HospFormaPago, tipoTarjeta?: HospTarjetaTipo | null): string {
  if (forma === "EFECTIVO") return "01";
  if (forma === "CHEQUE") return "02";
  if (forma === "TRANSFERENCIA") return "03";
  return tipoTarjeta === "DEBITO" ? "28" : "04";
}

/**
 * Las facturas PPD con saldo por complementar: lo que ya detecta el hub (cobro
 * conciliado en banco, o saldo insoluto sin cobro) más los cobros de caja
 * ligados a cada una. `sugerido` es el siguiente REP a emitir: el primer cobro
 * de caja que todavía no está amparado, o el saldo completo.
 */
export async function complementosHospital(db: Db, companyId: string) {
  const base = await pendientesRep(companyId);
  type Fila = { invoice: { id: string; uuid: string | null; serie: string | null; folio: string | null; fecha: Date; total: unknown; customer: { id: string; rfc: string; razonSocial: string } | null } };
  const vistas = new Map<string, Fila["invoice"]>();
  for (const p of (base.pendientes ?? []) as Fila[]) vistas.set(p.invoice.id, p.invoice);
  for (const p of ((base as { sinCobroDetectado?: Fila[] }).sinCobroDetectado ?? [])) vistas.set(p.invoice.id, p.invoice);

  // Cobros de caja ligados a PPD timbradas (incluye las que el banco aún no ve).
  const cobros = await db.hospCobro.findMany({
    where: { companyId, estado: { in: [...ESTADOS_COBRO_VIGENTE] }, invoice: { is: { tipo: "INGRESO", metodoPago: "PPD", status: "STAMPED" } } },
    select: {
      id: true, fecha: true, monto: true, formaPago: true, tipoTarjeta: true, referencia: true, invoiceId: true,
      invoice: { select: { id: true, uuid: true, serie: true, folio: true, fecha: true, total: true, customer: { select: { id: true, rfc: true, razonSocial: true } } } },
    },
    orderBy: { fecha: "asc" },
  });
  for (const c of cobros) if (c.invoice && !vistas.has(c.invoice.id)) vistas.set(c.invoice.id, c.invoice);

  const facturas = [...vistas.values()];
  const uuids = facturas.map((f) => f.uuid);
  const [amparado, reps] = await Promise.all([amparadoPorReps(db, companyId, uuids), repsPorFactura(db, companyId, uuids)]);
  const bancoDe = new Map<string, Array<{ id: string; fecha: Date; monto: number }>>();
  for (const p of (base.pendientes ?? []) as Array<{ invoice: { id: string }; payments: Array<{ id: string; fecha: Date; monto: unknown }> }>) {
    bancoDe.set(p.invoice.id, p.payments.map((x) => ({ id: x.id, fecha: x.fecha, monto: r2(Number(x.monto)) })));
  }

  const filas = facturas.map((f) => {
    const k = f.uuid ? normalizarUuid(f.uuid) : "";
    const total = r2(Number(f.total));
    const yaAmparado = r2(amparado.get(k) ?? 0);
    const saldo = r2(total - yaAmparado);
    const deCaja = cobros
      .filter((c) => c.invoiceId === f.id)
      .map((c) => ({ id: c.id, fecha: c.fecha, monto: r2(Number(c.monto)), formaPago: formaPagoSat(c.formaPago, c.tipoTarjeta), referencia: c.referencia }));
    // Los cobros de caja se amparan en orden de fecha: lo ya amparado cubre los
    // primeros; el siguiente sin cubrir es el REP que toca.
    let cubierto = yaAmparado;
    const cajaConEstado = deCaja.map((c) => {
      const amparadoYa = cubierto >= c.monto - 0.01;
      cubierto = r2(cubierto - c.monto);
      return { ...c, amparado: amparadoYa };
    });
    const siguiente = cajaConEstado.find((c) => !c.amparado);
    return {
      invoiceId: f.id,
      uuid: f.uuid,
      serie: f.serie,
      folio: f.folio,
      fecha: f.fecha,
      receptor: f.customer,
      total,
      amparado: yaAmparado,
      saldo,
      reps: reps.get(k) ?? [],
      cobrosBanco: bancoDe.get(f.id) ?? [],
      cobrosCaja: cajaConEstado,
      sugerido: siguiente
        ? { cobroId: siguiente.id, monto: Math.min(siguiente.monto, saldo), fechaPago: siguiente.fecha, formaPago: siguiente.formaPago }
        : saldo > 0.01 ? { cobroId: null, monto: saldo, fechaPago: null, formaPago: "03" } : null,
    };
  });
  return {
    facturas: filas.filter((f) => f.saldo > 0.01 || f.reps.length > 0).sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime()),
  };
}
