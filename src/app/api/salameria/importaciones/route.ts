/**
 * GET  /api/salameria/importaciones?companyId=... [&estado=]
 * POST /api/salameria/importaciones
 *
 * El contenedor. Se crea EN_TRANSITO con sus partidas y se le van colgando los
 * costos del pedimento conforme llegan las facturas del agente aduanal; cuando
 * está completo se LIBERA (POST …/liberar), que es donde nacen los lotes con
 * su costo aterrizado y donde se postea al mayor.
 *
 * Mientras está en tránsito NO hay inventario ni asiento: la mercancía todavía
 * no es vendible y su costo todavía no se conoce (falta la mitad del pedimento).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { conFolioUnico, siguienteFolio } from "@/lib/salameria/folio";

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "SALAMERIA", req);

  const estado = searchParams.get("estado");

  const importaciones = await prisma.salImportacion.findMany({
    where: {
      companyId,
      ...(estado ? { estado: estado as never } : {}),
    },
    orderBy: [{ fechaLlegada: "desc" }, { createdAt: "desc" }],
    include: {
      supplier: { select: { id: true, razonSocial: true } },
      items: { select: { cantidad: true, precioMoneda: true, costoUnitario: true } },
      costos: { select: { tipo: true, importe: true, prorratea: true } },
      _count: { select: { items: true, lotes: true } },
    },
    take: 200,
  });

  const resumen = importaciones.map((imp) => {
    const tc = Number(imp.tipoCambio);
    const valorMercancia =
      Math.round(
        imp.items.reduce((a, i) => a + Number(i.cantidad) * Number(i.precioMoneda) * tc, 0) *
          100
      ) / 100;
    const costosProrrateados =
      Math.round(
        imp.costos.filter((c) => c.prorratea).reduce((a, c) => a + Number(c.importe), 0) * 100
      ) / 100;
    const ivaImportacion =
      Math.round(
        imp.costos
          .filter((c) => !c.prorratea && c.tipo === "IVA_IMPORTACION")
          .reduce((a, c) => a + Number(c.importe), 0) * 100
      ) / 100;
    return {
      ...imp,
      items: undefined,
      costos: undefined,
      valorMercancia,
      costosProrrateados,
      ivaImportacion,
      costoMercancia: Math.round((valorMercancia + costosProrrateados) * 100) / 100,
    };
  });

  return NextResponse.json(resumen);
});

const createSchema = z.object({
  companyId: z.string().min(1),
  supplierId: z.string().nullable().optional(),
  pedimento: z.string().max(30).nullable().optional(),
  aduana: z.string().max(80).nullable().optional(),
  fechaPedimento: z.coerce.date().nullable().optional(),
  fechaLlegada: z.coerce.date().nullable().optional(),
  moneda: z.string().min(3).max(3).default("USD"),
  tipoCambio: z.number().positive().default(1),
  notas: z.string().max(2000).nullable().optional(),
  items: z
    .array(
      z.object({
        productoId: z.string().min(1),
        cantidad: z.number().positive(),
        precioMoneda: z.number().min(0),
        loteCodigo: z.string().max(60).nullable().optional(),
        caducidad: z.coerce.date().nullable().optional(),
      })
    )
    .min(1),
});

export const POST = withAuthz(async (req: Request) => {
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, items, ...cabecera } = parsed.data;

  await requireWriter(companyId, req);
  await requireModule(companyId, "SALAMERIA", req);

  // Todas las partidas tienen que ser de ESTA empresa: sin la verificación, un
  // productoId de otro tenant entraría al inventario propio por la puerta de
  // atrás (el @@index por companyId no lo impide, la FK apunta al producto).
  const productos = await prisma.salProducto.findMany({
    where: { id: { in: items.map((i) => i.productoId) }, companyId },
    select: { id: true },
  });
  if (productos.length !== new Set(items.map((i) => i.productoId)).size) {
    return NextResponse.json(
      { error: "Alguna partida apunta a un producto que no es de esta empresa" },
      { status: 400 }
    );
  }

  const importacion = await conFolioUnico(() =>
    prisma.$transaction(async (tx) => {
      const folio = await siguienteFolio(tx, companyId, "importacion");
      return tx.salImportacion.create({
        data: {
          companyId,
          folio,
          ...cabecera,
          items: { create: items },
        },
        include: { items: true, costos: true },
      });
    })
  );

  return NextResponse.json(importacion, { status: 201 });
});
