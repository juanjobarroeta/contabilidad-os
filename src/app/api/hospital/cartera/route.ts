/**
 * GET /api/hospital/cartera?companyId=…&lado=COBRAR|PAGAR
 *
 * Cartera agregada por contacto con antigüedad (estado de cuenta por pagador):
 *   COBRAR → facturas INGRESO por cliente: facturado, cobrado, saldo, PPD
 *            cobrado sin REP emitido, y el saldo partido en 0-30/31-60/61-90/90+.
 *   PAGAR  → facturas EGRESO por proveedor: pagado y pagos PPD sin REP recibido.
 * Misma evidencia de pago y mismo empate por UUID que automotriz/cartera. Cada
 * fila trae el convenio (HospPagador) ligado al RFC, y `porPagador` agrupa el
 * lado COBRAR como lo lee dirección: aseguradoras/empresas por convenio y los
 * particulares en un solo renglón. Sólo lectura.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";
import {
  acumularAging,
  agingVacio,
  amparadoDe,
  amparadoPorReps,
  bucketAging,
  conciliadoDe,
  pagadoPorEvidencia,
  r2,
  sumarAging,
  type Aging,
} from "@/lib/hospital/cobranza";

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const lado = searchParams.get("lado") === "PAGAR" ? "PAGAR" : "COBRAR";
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const hoy = new Date();
  const tipo = lado === "COBRAR" ? "INGRESO" : "EGRESO";
  const [facturas, pagadores] = await Promise.all([
    prisma.invoice
      .findMany({
        where: { companyId, tipo, status: { not: "CANCELLED" }, customerId: { not: null } },
        select: {
          customerId: true,
          uuid: true,
          total: true,
          metodoPago: true,
          tipoSat: true,
          fecha: true,
          customer: { select: { razonSocial: true, rfc: true } },
          conciliacionDetalles: { select: { montoAsignado: true } },
        },
      })
      .then((rows) => rows.map((f) => ({ ...f, total: Number(f.total) }))),
    prisma.hospPagador.findMany({
      where: { companyId, customerId: { not: null } },
      select: { id: true, nombre: true, tipo: true, customerId: true, plazoDias: true, vigenciaFin: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const amparado = await amparadoPorReps(
    prisma,
    facturas.filter((f) => (f.tipoSat ?? "I") !== "E").map((f) => f.uuid)
  );
  const pagadorPorCustomer = new Map<string, (typeof pagadores)[number]>();
  for (const p of pagadores) {
    if (p.customerId && !pagadorPorCustomer.has(p.customerId)) pagadorPorCustomer.set(p.customerId, p);
  }

  type Fila = {
    customerId: string; razonSocial: string; rfc: string;
    pagadorId: string | null; pagadorNombre: string | null; pagadorTipo: string | null;
    facturas: number; facturado: number; pagado: number; saldo: number;
    repPendiente: number; notasCredito: number; masAntigua: string | null; aging: Aging;
  };
  const porContacto = new Map<string, Fila>();
  for (const f of facturas) {
    const fila = porContacto.get(f.customerId!) ?? {
      customerId: f.customerId!,
      razonSocial: f.customer?.razonSocial ?? "—",
      rfc: f.customer?.rfc ?? "—",
      pagadorId: pagadorPorCustomer.get(f.customerId!)?.id ?? null,
      pagadorNombre: pagadorPorCustomer.get(f.customerId!)?.nombre ?? null,
      pagadorTipo: pagadorPorCustomer.get(f.customerId!)?.tipo ?? null,
      facturas: 0, facturado: 0, pagado: 0, saldo: 0, repPendiente: 0, notasCredito: 0,
      masAntigua: null, aging: agingVacio(),
    };
    porContacto.set(f.customerId!, fila);
    // Las notas de crédito (tipoSat "E") no son cartera: se reportan aparte y
    // NO netean el saldo — una nota puede amparar una devolución ya pagada y
    // netearla a ciegas inventaría cobros.
    if ((f.tipoSat ?? "I") === "E") {
      fila.notasCredito += f.total;
      continue;
    }
    const ev = pagadoPorEvidencia({
      metodoPago: f.metodoPago,
      total: f.total,
      conciliado: conciliadoDe(f.conciliacionDetalles),
      amparadoRep: amparadoDe(amparado, f.uuid),
    });
    fila.facturas += 1;
    fila.facturado += f.total;
    fila.pagado += ev.pagado;
    fila.saldo += ev.saldo;
    fila.repPendiente += ev.repPendiente;
    if (ev.saldo > 0) sumarAging(fila.aging, bucketAging(f.fecha, hoy), ev.saldo);
    if (ev.saldo > 1 && (!fila.masAntigua || f.fecha.toISOString() < fila.masAntigua)) {
      fila.masAntigua = f.fecha.toISOString();
    }
  }

  const filas = [...porContacto.values()]
    .map((f) => ({
      ...f,
      facturado: r2(f.facturado),
      pagado: r2(f.pagado),
      saldo: r2(f.saldo),
      repPendiente: r2(f.repPendiente),
      notasCredito: r2(f.notasCredito),
    }))
    .filter((f) => f.saldo > 1 || f.repPendiente > 1)
    .sort((a, b) => b.saldo - a.saldo);

  const aging = filas.reduce((acc, f) => acumularAging(acc, f.aging), agingVacio());
  const totales = {
    contactos: filas.length,
    facturas: filas.reduce((s, f) => s + f.facturas, 0),
    facturado: r2(filas.reduce((s, f) => s + f.facturado, 0)),
    pagado: r2(filas.reduce((s, f) => s + f.pagado, 0)),
    saldo: r2(filas.reduce((s, f) => s + f.saldo, 0)),
    repPendiente: r2(filas.reduce((s, f) => s + f.repPendiente, 0)),
    masDe30: r2(aging["31-60"] + aging["61-90"] + aging["90+"]),
  };

  // Por convenio: cada aseguradora/empresa en su renglón; los RFC sin convenio
  // se agrupan como «Particulares» (así lo lee el estado de cuenta).
  const porPagador = new Map<string, { pagadorId: string | null; nombre: string; tipo: string; contactos: number; facturas: number; saldo: number; aging: Aging }>();
  for (const f of filas) {
    const k = f.pagadorId ?? "PARTICULAR";
    const g = porPagador.get(k) ?? {
      pagadorId: f.pagadorId,
      nombre: f.pagadorNombre ?? "Particulares",
      tipo: f.pagadorTipo ?? "PARTICULAR",
      contactos: 0, facturas: 0, saldo: 0, aging: agingVacio(),
    };
    g.contactos += 1;
    g.facturas += f.facturas;
    g.saldo = r2(g.saldo + f.saldo);
    acumularAging(g.aging, f.aging);
    porPagador.set(k, g);
  }

  return NextResponse.json({
    lado,
    hoy: hoy.toISOString(),
    resumen: { contactos: filas.length, saldoTotal: totales.saldo, repPendienteTotal: totales.repPendiente },
    totales,
    aging,
    filas,
    porPagador: [...porPagador.values()].sort((a, b) => b.saldo - a.saldo),
  });
});
