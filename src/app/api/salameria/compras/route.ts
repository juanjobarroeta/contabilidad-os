/**
 * GET  /api/salameria/compras?companyId=... [&estado=]
 * POST /api/salameria/compras
 *
 * Compra NACIONAL a proveedor — lo que no entra por aduana (empaque, insumos
 * locales, reposición urgente a un mayorista mexicano). El ciclo es
 * ORDENADA → RECIBIDA → PAGADA y vive en /compras/[id].
 *
 * A diferencia de la importación no hay prorrateo: el costo unitario es el que
 * viene en la factura del proveedor, y el IVA se captura explícito porque casi
 * todo el abarrote es tasa 0 %.
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

  const compras = await prisma.salCompra.findMany({
    where: { companyId, ...(estado ? { estado: estado as never } : {}) },
    orderBy: [{ fecha: "desc" }, { createdAt: "desc" }],
    include: {
      supplier: { select: { id: true, razonSocial: true, rfc: true } },
      _count: { select: { items: true } },
    },
    take: 200,
  });

  return NextResponse.json(compras);
});

const createSchema = z.object({
  companyId: z.string().min(1),
  supplierId: z.string().nullable().optional(),
  fecha: z.coerce.date().optional(),
  iva: z.number().min(0).default(0),
  notas: z.string().max(2000).nullable().optional(),
  items: z
    .array(
      z.object({
        productoId: z.string().min(1),
        cantidad: z.number().positive(),
        costoUnitario: z.number().min(0),
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
  const { companyId, items, iva, ...cabecera } = parsed.data;

  await requireWriter(companyId, req);
  await requireModule(companyId, "SALAMERIA", req);

  const propios = await prisma.salProducto.count({
    where: { id: { in: items.map((i) => i.productoId) }, companyId },
  });
  if (propios !== new Set(items.map((i) => i.productoId)).size) {
    return NextResponse.json(
      { error: "Alguna partida apunta a un producto que no es de esta empresa" },
      { status: 400 }
    );
  }

  const conImporte = items.map((i) => ({
    ...i,
    importe: Math.round(i.cantidad * i.costoUnitario * 1e6) / 1e6,
  }));
  const subtotal =
    Math.round(conImporte.reduce((a, i) => a + i.importe, 0) * 1e6) / 1e6;

  const compra = await conFolioUnico(() =>
    prisma.$transaction(async (tx) => {
      const folio = await siguienteFolio(tx, companyId, "compra");
      return tx.salCompra.create({
        data: {
          companyId,
          folio,
          ...cabecera,
          subtotal,
          iva,
          items: { create: conImporte },
        },
        include: { items: true },
      });
    })
  );

  return NextResponse.json(compra, { status: 201 });
});
