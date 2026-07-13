/**
 * GET  /api/restaurante/compras?companyId=... [&estado=...]
 * POST /api/restaurante/compras
 *
 * Órdenes de compra de insumos. Lifecycle: BORRADOR/ORDENADA → RECIBIDA
 * (stock + costo promedio + asiento almacén/acreedores) → PAGADA (asiento
 * acreedores/caja-bancos). CANCELADA only before receiving.
 *
 * POST body: { companyId, supplierId?, fecha?, iva?, notas?, estado?,
 *              items: [{ insumoId, cantidad, costoUnitario }] }
 * subtotal is always computed server-side from the items.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";

const round2 = (n: number) => Math.round(n * 100) / 100;

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "RESTAURANTE", req);

  const estado = searchParams.get("estado");
  const compras = await prisma.restCompra.findMany({
    where: {
      companyId,
      ...(estado
        ? { estado: estado as "BORRADOR" | "ORDENADA" | "RECIBIDA" | "PAGADA" | "CANCELADA" }
        : {}),
    },
    include: {
      supplier: { select: { id: true, razonSocial: true, rfc: true } },
      items: { include: { insumo: { select: { id: true, nombre: true, unidad: true } } } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return NextResponse.json(compras);
});

const itemSchema = z.object({
  insumoId: z.string().min(1),
  cantidad: z.number().positive(),
  costoUnitario: z.number().min(0),
});

const createSchema = z.object({
  companyId: z.string().min(1),
  supplierId: z.string().nullable().optional(),
  fecha: z.string().datetime().optional(),
  iva: z.number().min(0).default(0),
  notas: z.string().max(1000).nullable().optional(),
  estado: z.enum(["BORRADOR", "ORDENADA"]).default("ORDENADA"),
  items: z.array(itemSchema).min(1),
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, supplierId, iva, notas, estado, items } = parsed.data;
  const fecha = parsed.data.fecha ? new Date(parsed.data.fecha) : new Date();

  await requireWriter(companyId, req);
  await requireModule(companyId, "RESTAURANTE", req);

  // Every insumo must belong to this company.
  const insumoIds = [...new Set(items.map((i) => i.insumoId))];
  const insumos = await prisma.restInsumo.findMany({
    where: { id: { in: insumoIds }, companyId },
    select: { id: true },
  });
  if (insumos.length !== insumoIds.length) {
    return NextResponse.json({ error: "Insumo inválido en la compra" }, { status: 400 });
  }

  if (supplierId) {
    const supplier = await prisma.supplier.findUnique({
      where: { id: supplierId },
      select: { companyId: true },
    });
    if (!supplier || supplier.companyId !== companyId) {
      return NextResponse.json({ error: "Proveedor inválido" }, { status: 400 });
    }
  }

  const subtotal = round2(
    items.reduce((sum, i) => sum + i.cantidad * i.costoUnitario, 0)
  );

  const compra = await prisma.$transaction(async (tx) => {
    // Consecutivo por empresa: OC-0001, OC-0002, …
    const last = await tx.restCompra.findFirst({
      where: { companyId },
      orderBy: { createdAt: "desc" },
      select: { folio: true },
    });
    const lastNum = last ? parseInt(last.folio.replace(/\D/g, ""), 10) || 0 : 0;
    const folio = `OC-${String(lastNum + 1).padStart(4, "0")}`;

    return tx.restCompra.create({
      data: {
        companyId,
        folio,
        supplierId: supplierId ?? null,
        estado,
        fecha,
        subtotal,
        iva: round2(iva),
        notas: notas ?? null,
        items: {
          create: items.map((i) => ({
            insumoId: i.insumoId,
            cantidad: i.cantidad,
            costoUnitario: i.costoUnitario,
            importe: round2(i.cantidad * i.costoUnitario),
          })),
        },
      },
      include: {
        supplier: { select: { id: true, razonSocial: true } },
        items: { include: { insumo: { select: { id: true, nombre: true, unidad: true } } } },
      },
    });
  });

  return NextResponse.json(compra, { status: 201 });
});
