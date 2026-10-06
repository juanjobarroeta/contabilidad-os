/**
 * GET /api/construccion/reportes/estado-resultados?companyId=…[&proyectoId=…]
 *
 * Estado de resultados por obra, acumulado a la fecha, todo SIN IVA:
 *
 *   ingresos.facturado  — Σ subtotal de estimaciones TIMBRADA/PAGADA (las que
 *                         ya tienen CFDI de ingreso).
 *   ingresos.cobrado    — las PAGADA (o con movimiento bancario ligado).
 *   ingresos.porFacturar— contrato − facturado (si hay monto contratado).
 *   costos.compras      — adjudicaciones de requisiciones APROBADA/PAGADA:
 *                         subtotal cuando hay desglose; total en las legadas
 *                         sin desglose (se reporta cuántas son).
 *   costos.gastos       — Gasto APROBADO/PAGADO directos e indirectos (importe).
 *   costos.destajo      — RayaSemanal PAGADA.
 *   utilidadBruta       — facturado − costos; margen = utilidad / facturado.
 *
 * Contexto: montoContratado y presupuesto base (CONTRATO aprobado o el más
 * reciente). Totales de la empresa al final. Los montos de IVA van aparte
 * (ivaTrasladado / ivaAcreditable) por si se quiere ver el flujo con IVA.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => (v == null ? 0 : Number(v));

export const GET = withAuthz(async (req: Request) => {
  const url = new URL(req.url);
  const companyId = url.searchParams.get("companyId");
  const proyectoId = url.searchParams.get("proyectoId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "CONSTRUCCION");

  const proyectos = await prisma.proyecto.findMany({
    where: { companyId, ...(proyectoId ? { id: proyectoId } : {}) },
    orderBy: [{ estado: "asc" }, { codigo: "asc" }],
    select: {
      id: true,
      codigo: true,
      nombre: true,
      tipo: true,
      estado: true,
      montoContratado: true,
      aplicaIva: true,
      customer: { select: { id: true, razonSocial: true } },
      presupuestos: {
        select: { tipoPresupuesto: true, estado: true, montoTotal: true, createdAt: true },
      },
      estimaciones: {
        where: { estado: { in: ["TIMBRADA", "PAGADA"] } },
        select: { estado: true, subtotal: true, iva: true, total: true, bankTransactionId: true, invoiceId: true },
      },
    },
  });
  const ids = proyectos.map((p) => p.id);

  const [adjudicaciones, gastos, rayas] = await Promise.all([
    prisma.solicitudAdjudicacion.findMany({
      where: {
        companyId,
        solicitud: { proyectoId: { in: ids }, estado: { in: ["APROBADA", "PAGADA"] } },
      },
      select: { total: true, subtotal: true, iva: true, solicitud: { select: { proyectoId: true } } },
    }),
    prisma.gasto.findMany({
      where: { companyId, proyectoId: { in: ids }, estado: { in: ["APROBADO", "PAGADO"] } },
      select: { proyectoId: true, importe: true, indirecto: true },
    }),
    prisma.rayaSemanal.findMany({
      where: { proyectoId: { in: ids }, estado: "PAGADA" },
      select: { proyectoId: true, total: true },
    }),
  ]);

  type Acum = {
    compras: number;
    comprasIva: number;
    comprasSinDesglose: number;
    gastosDirectos: number;
    gastosIndirectos: number;
    destajo: number;
  };
  const acum = new Map<string, Acum>();
  const de = (pid: string) => {
    let a = acum.get(pid);
    if (!a) {
      a = { compras: 0, comprasIva: 0, comprasSinDesglose: 0, gastosDirectos: 0, gastosIndirectos: 0, destajo: 0 };
      acum.set(pid, a);
    }
    return a;
  };
  for (const a of adjudicaciones) {
    const pid = a.solicitud.proyectoId;
    if (!pid) continue;
    const x = de(pid);
    if (a.subtotal != null) {
      x.compras += num(a.subtotal);
      x.comprasIva += num(a.iva);
    } else {
      // legado sin desglose: el total es lo pagado; no se sabe cuánto es IVA
      x.compras += num(a.total);
      x.comprasSinDesglose++;
    }
  }
  for (const g of gastos) {
    if (!g.proyectoId) continue;
    const x = de(g.proyectoId);
    if (g.indirecto) x.gastosIndirectos += num(g.importe);
    else x.gastosDirectos += num(g.importe);
  }
  for (const r of rayas) de(r.proyectoId).destajo += num(r.total);

  const filas = proyectos.map((p) => {
    const base =
      p.presupuestos.find((b) => b.tipoPresupuesto === "CONTRATO" && (b.estado === "APROBADO" || b.estado === "EN_EJECUCION")) ??
      [...p.presupuestos].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    const facturado = round2(p.estimaciones.reduce((s, e) => s + num(e.subtotal), 0));
    const ivaTrasladado = round2(p.estimaciones.reduce((s, e) => s + num(e.iva), 0));
    const cobrado = round2(
      p.estimaciones.filter((e) => e.estado === "PAGADA" || e.bankTransactionId).reduce((s, e) => s + num(e.subtotal), 0)
    );
    const contrato = p.montoContratado == null ? null : num(p.montoContratado);
    const c = de(p.id);
    const costos = round2(c.compras + c.gastosDirectos + c.gastosIndirectos + c.destajo);
    const utilidadBruta = round2(facturado - costos);
    return {
      proyectoId: p.id,
      codigo: p.codigo,
      nombre: p.nombre,
      tipo: p.tipo,
      estado: p.estado,
      cliente: p.customer,
      contrato,
      presupuesto: base ? round2(num(base.montoTotal)) : null,
      ingresos: {
        estimaciones: p.estimaciones.length,
        facturado,
        cobrado,
        porCobrar: round2(facturado - cobrado),
        porFacturar: contrato == null ? null : round2(contrato - facturado),
        avancePct: contrato ? round2((facturado / contrato) * 100) : null,
        ivaTrasladado,
      },
      costos: {
        compras: round2(c.compras),
        comprasSinDesglose: c.comprasSinDesglose,
        gastosDirectos: round2(c.gastosDirectos),
        gastosIndirectos: round2(c.gastosIndirectos),
        destajo: round2(c.destajo),
        total: costos,
        ivaAcreditable: round2(c.comprasIva),
        vsPresupuestoPct: base && num(base.montoTotal) > 0 ? round2((costos / num(base.montoTotal)) * 100) : null,
      },
      utilidadBruta,
      margenPct: facturado > 0 ? round2((utilidadBruta / facturado) * 100) : null,
    };
  });

  const sum = (f: (r: (typeof filas)[number]) => number | null) => round2(filas.reduce((s, r) => s + (f(r) ?? 0), 0));
  const facturado = sum((r) => r.ingresos.facturado);
  const costos = sum((r) => r.costos.total);
  const totales = {
    proyectos: filas.length,
    contrato: sum((r) => r.contrato),
    facturado,
    cobrado: sum((r) => r.ingresos.cobrado),
    compras: sum((r) => r.costos.compras),
    gastos: sum((r) => r.costos.gastosDirectos + r.costos.gastosIndirectos),
    destajo: sum((r) => r.costos.destajo),
    costos,
    utilidadBruta: round2(facturado - costos),
    margenPct: facturado > 0 ? round2(((facturado - costos) / facturado) * 100) : null,
  };

  return NextResponse.json({ companyId, moneda: "MXN", sinIva: true, proyectos: filas, totales });
});
