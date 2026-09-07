/**
 * GET /api/salameria/almacen/lotes?companyId=... [&productoId=][&estado=POR_VENCER|VENCIDO][&q=]
 *
 * El almacén visto como lo que es: filas de lote con caducidad y costo.
 *
 * `estado` es la pantalla que gana o pierde dinero en un negocio de alimentos.
 * VENCIDO ya es pérdida (hay que darlo de baja); POR_VENCER es el que todavía
 * se puede rematar. La ventana la fija cada empresa en
 * `SalConfig.diasAlertaCaducidad` (90 por default) porque no es lo mismo
 * chocolate que masa de hojaldre.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "SALAMERIA", req);

  const productoId = searchParams.get("productoId");
  const estado = searchParams.get("estado");
  const q = searchParams.get("q");

  const cfg = await prisma.salConfig.findUnique({
    where: { companyId },
    select: { diasAlertaCaducidad: true },
  });
  const dias = cfg?.diasAlertaCaducidad ?? 90;

  const hoy = new Date();
  const corte = new Date(hoy.getTime() + dias * 86_400_000);

  const lotes = await prisma.salLote.findMany({
    where: {
      companyId,
      cantidad: { gt: 0 },
      ...(productoId ? { productoId } : {}),
      ...(estado === "VENCIDO" ? { caducidad: { lt: hoy } } : {}),
      // POR_VENCER excluye a los ya vencidos: son dos listas de trabajo
      // distintas (una se remata, la otra se da de baja).
      ...(estado === "POR_VENCER" ? { caducidad: { gte: hoy, lte: corte } } : {}),
      ...(q
        ? {
            OR: [
              { codigo: { contains: q, mode: "insensitive" as const } },
              { producto: { nombre: { contains: q, mode: "insensitive" as const } } },
              { producto: { sku: { contains: q, mode: "insensitive" as const } } },
            ],
          }
        : {}),
    },
    orderBy: [{ caducidad: "asc" }, { createdAt: "asc" }],
    include: {
      producto: {
        select: { id: true, sku: true, nombre: true, marca: true, unidad: true },
      },
      importacion: { select: { id: true, folio: true, pedimento: true } },
      compra: { select: { id: true, folio: true } },
    },
    take: 500,
  });

  const conValor = lotes.map((l) => {
    const cantidad = Number(l.cantidad);
    const costoUnitario = Number(l.costoUnitario);
    const dd =
      l.caducidad == null
        ? null
        : Math.floor((l.caducidad.getTime() - hoy.getTime()) / 86_400_000);
    return {
      ...l,
      valor: Math.round(cantidad * costoUnitario * 100) / 100,
      diasParaVencer: dd,
      vencido: dd != null && dd < 0,
      porVencer: dd != null && dd >= 0 && dd <= dias,
    };
  });

  return NextResponse.json({
    diasAlerta: dias,
    valorTotal:
      Math.round(conValor.reduce((a, l) => a + l.valor, 0) * 100) / 100,
    lotes: conValor,
  });
});
