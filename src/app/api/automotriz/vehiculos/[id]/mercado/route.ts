import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { consultarMercadoVehiculo } from "@/lib/automotriz/mercado";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/automotriz/vehiculos/[id]/mercado — «¿A cómo está el mercado?»
// para una unidad (seminuevos): rango de listados comparables por
// marca+modelo+año en autos de ML MX. CACHEADO 7 días (el mercado de autos se
// mueve lento y la cuota es mensual); ?forzar=1 lo salta. Alimenta el precio
// de lista del seminuevo y, en R2, la toma a cuenta.
// ─────────────────────────────────────────────────────────────────────────────

export const POST = withAuthz(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const vehiculo = await prisma.vehiculo.findUnique({
    where: { id },
    select: { id: true, companyId: true, marca: true, modelo: true, anio: true, mercado: true },
  });
  if (!vehiculo) throw new AuthzError(404, "Unidad no encontrada");
  await requireWriter(vehiculo.companyId, req);
  await requireModule(vehiculo.companyId, "AUTOMOTRIZ", req);

  const forzar = new URL(req.url).searchParams.get("forzar") === "1";
  const fresco =
    vehiculo.mercado &&
    Date.now() - new Date(vehiculo.mercado.consultadoAt).getTime() < 7 * 24 * 60 * 60 * 1000;
  if (fresco && !forzar) return NextResponse.json({ ...vehiculo.mercado, cache: true });

  let resumen;
  try {
    resumen = await consultarMercadoVehiculo(vehiculo.marca, vehiculo.modelo, vehiculo.anio);
  } catch (e) {
    return NextResponse.json(
      { error: `No se pudo consultar el mercado: ${e instanceof Error ? e.message : "error"}` },
      { status: 502 }
    );
  }

  const datos = {
    consultadoAt: new Date(),
    precioMin: resumen.precioMin,
    precioMax: resumen.precioMax,
    precioMediana: resumen.precioMediana,
    listados: resumen.listados,
    resultados: resumen.resultados,
  };
  const guardado = await prisma.vehiculoMercado.upsert({
    where: { vehiculoId: id },
    create: { companyId: vehiculo.companyId, vehiculoId: id, ...datos },
    update: datos,
  });
  return NextResponse.json(guardado);
});
