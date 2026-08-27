import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { consultarMercado } from "@/lib/automotriz/mercado";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/automotriz/refacciones/[id]/mercado — el botón «Consultar mercado»
// de la ficha: busca la parte en el buscador restringido (ML MX) y guarda el
// resumen. CACHEADO 24h (la cuota gratis es de 100/día y la comparte el cron);
// ?forzar=1 lo salta.
// ─────────────────────────────────────────────────────────────────────────────

export const POST = withAuthz(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const refaccion = await prisma.refaccion.findUnique({
    where: { id },
    select: { id: true, companyId: true, numeroParte: true, descripcion: true, mercado: true },
  });
  if (!refaccion) throw new AuthzError(404, "Refacción no encontrada");
  await requireWriter(refaccion.companyId, req);
  await requireModule(refaccion.companyId, "AUTOMOTRIZ", req);

  const forzar = new URL(req.url).searchParams.get("forzar") === "1";
  const fresco =
    refaccion.mercado &&
    Date.now() - new Date(refaccion.mercado.consultadoAt).getTime() < 24 * 60 * 60 * 1000;
  if (fresco && !forzar) {
    return NextResponse.json({ ...refaccion.mercado, cache: true });
  }

  let resumen;
  try {
    resumen = await consultarMercado(refaccion.numeroParte, refaccion.descripcion);
  } catch (e) {
    return NextResponse.json(
      { error: `No se pudo consultar el mercado: ${e instanceof Error ? e.message : "error"}` },
      { status: 502 }
    );
  }

  const guardado = await prisma.refaccionMercado.upsert({
    where: { refaccionId: id },
    create: {
      companyId: refaccion.companyId,
      refaccionId: id,
      consultadoAt: new Date(),
      titulo: resumen.titulo,
      precioMercado: resumen.precioMercado,
      urlPrincipal: resumen.urlPrincipal,
      resultados: resumen.resultados,
    },
    update: {
      consultadoAt: new Date(),
      titulo: resumen.titulo,
      precioMercado: resumen.precioMercado,
      urlPrincipal: resumen.urlPrincipal,
      resultados: resumen.resultados,
    },
  });
  return NextResponse.json(guardado);
});
