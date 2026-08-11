/**
 * GET /api/automotriz/panel?companyId=…
 *
 * KPIs del Panel de la agencia (handoff «Nórdico»): piso (unidades, valor,
 * aging, +90 días), mes en curso (vendidas, ingresos, margen real por VIN,
 * ISAN causado) y feed de urgentes (unidades +90 días y apartadas sin
 * facturar) con liga a la unidad. Sólo lectura, todo derivado de datos que el
 * módulo ya posee — la posición fiscal completa vive en el hub (link out).
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

const r2 = (n: number) => Math.round(n * 100) / 100;
const DIA_MS = 24 * 60 * 60 * 1000;

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  const hoy = new Date();
  const inicioMes = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), 1));

  const ABIERTOS_CRM = ["NUEVO", "CONTACTADO", "CITA", "DEMO", "NEGOCIACION"] as const;
  const [enPiso, vendidasMes, ordenesAbiertas, promesasVencidas, prospectosAbiertos, seguimientosVencidos] = await Promise.all([
    prisma.vehiculo.findMany({
      where: { companyId, estado: { in: ["DISPONIBLE", "APARTADO"] } },
      select: {
        id: true, vin: true, marca: true, modelo: true, anio: true, estado: true, uso: true,
        costoCompra: true, fechaCompra: true,
        costos: { select: { monto: true } },
      },
    }),
    prisma.vehiculo.findMany({
      where: { companyId, estado: { in: ["VENDIDO", "ENTREGADO"] }, fechaVenta: { gte: inicioMes } },
      select: {
        precioVenta: true, costoCompra: true, comisionMonto: true, isan: true,
        costos: { select: { monto: true } },
      },
    }),
    // La operación de HOY: taller y CRM (fases 5b/2) en el mismo vistazo.
    prisma.ordenServicio.groupBy({
      by: ["estado"],
      where: { companyId, estado: { in: ["RECIBIDA", "EN_PROCESO", "LISTA"] } },
      _count: { _all: true },
    }),
    prisma.ordenServicio.findMany({
      where: {
        companyId,
        estado: { in: ["RECIBIDA", "EN_PROCESO"] },
        prometidaAt: { lt: new Date() },
      },
      select: { id: true, folio: true, descripcionUnidad: true, prometidaAt: true },
      orderBy: { prometidaAt: "asc" },
      take: 5,
    }),
    prisma.prospecto.count({ where: { companyId, estado: { in: [...ABIERTOS_CRM] } } }),
    prisma.prospecto.count({
      where: { companyId, estado: { in: [...ABIERTOS_CRM] }, proximaAccion: { lt: new Date() } },
    }),
  ]);

  const dias = (v: { fechaCompra: Date | null }) =>
    v.fechaCompra ? Math.floor((hoy.getTime() - v.fechaCompra.getTime()) / DIA_MS) : null;

  const valorPiso = r2(
    enPiso.reduce((s, v) => s + v.costoCompra + v.costos.reduce((c, x) => c + x.monto, 0), 0)
  );
  // Las demos/cortesías no suenan en el aging: están en piso a propósito.
  const enVenta = enPiso.filter((v) => v.uso === "VENTA");
  const masDe90 = enVenta.filter((v) => (dias(v) ?? 0) > 90);

  const ingresosMes = r2(vendidasMes.reduce((s, v) => s + (v.precioVenta ?? 0), 0));
  const margenMes = r2(
    vendidasMes.reduce(
      (s, v) =>
        s + (v.precioVenta ?? 0) - v.costoCompra -
        v.costos.reduce((c, x) => c + x.monto, 0) - v.comisionMonto,
      0
    )
  );
  const isanMes = r2(vendidasMes.reduce((s, v) => s + v.isan, 0));

  // Urgentes: primero las unidades con más días en piso, luego apartadas.
  const urgentes = [
    ...masDe90
      .sort((a, b) => (dias(b) ?? 0) - (dias(a) ?? 0))
      .slice(0, 5)
      .map((v) => ({
        tipo: "PISO_90" as const,
        vehiculoId: v.id,
        titulo: `${v.marca} ${v.modelo} ${v.anio}`,
        detalle: `${dias(v)} días en piso · VIN ${v.vin}`,
      })),
    ...enPiso
      .filter((v) => v.estado === "APARTADO")
      .slice(0, 5)
      .map((v) => ({
        tipo: "APARTADA" as const,
        vehiculoId: v.id,
        titulo: `${v.marca} ${v.modelo} ${v.anio}`,
        detalle: `Apartada sin facturar · VIN ${v.vin}`,
      })),
  ];

  return NextResponse.json({
    periodo: { year: hoy.getUTCFullYear(), month: hoy.getUTCMonth() + 1 },
    piso: {
      unidades: enPiso.length,
      valorPiso,
      masDe90: masDe90.length,
      diasPromedio: enVenta.length
        ? Math.round(enVenta.reduce((s, v) => s + (dias(v) ?? 0), 0) / enVenta.length)
        : 0,
      demos: enPiso.filter((v) => v.uso !== "VENTA").length,
    },
    mes: { vendidas: vendidasMes.length, ingresos: ingresosMes, margen: margenMes, isan: isanMes },
    taller: {
      abiertas: ordenesAbiertas.reduce((s, o) => s + o._count._all, 0),
      porEstado: Object.fromEntries(ordenesAbiertas.map((o) => [o.estado, o._count._all])),
      promesasVencidas: promesasVencidas.map((o) => ({
        id: o.id,
        folio: o.folio,
        unidad: o.descripcionUnidad,
        prometidaAt: o.prometidaAt,
      })),
    },
    crm: { abiertos: prospectosAbiertos, vencidos: seguimientosVencidos },
    urgentes,
  });
});
