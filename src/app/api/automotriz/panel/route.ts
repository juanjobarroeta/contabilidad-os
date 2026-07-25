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

  const [enPiso, vendidasMes] = await Promise.all([
    prisma.vehiculo.findMany({
      where: { companyId, estado: { in: ["DISPONIBLE", "APARTADO"] } },
      select: {
        id: true, vin: true, marca: true, modelo: true, anio: true, estado: true,
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
  ]);

  const dias = (v: { fechaCompra: Date | null }) =>
    v.fechaCompra ? Math.floor((hoy.getTime() - v.fechaCompra.getTime()) / DIA_MS) : null;

  const valorPiso = r2(
    enPiso.reduce((s, v) => s + v.costoCompra + v.costos.reduce((c, x) => c + x.monto, 0), 0)
  );
  const masDe90 = enPiso.filter((v) => (dias(v) ?? 0) > 90);

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
      diasPromedio: enPiso.length
        ? Math.round(enPiso.reduce((s, v) => s + (dias(v) ?? 0), 0) / enPiso.length)
        : 0,
    },
    mes: { vendidas: vendidasMes.length, ingresos: ingresosMes, margen: margenMes, isan: isanMes },
    urgentes,
  });
});
