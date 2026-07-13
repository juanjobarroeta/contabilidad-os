/**
 * GET  /api/restaurante/ordenes?companyId=... [&estado=] [&from=] [&to=]
 * POST /api/restaurante/ordenes
 *
 * Comandas. POST creates an open order with its initial items; prices are
 * frozen from the menu at add time and every item starts PENDIENTE for the
 * kitchen. Folio is a per-company consecutive integer.
 *
 * POST body: { companyId, tipo?, mesa?, comensales?, clienteNombre?, notas?,
 *              items: [{ menuItemId, cantidad, notas? }] }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";

const ordenInclude = {
  customer: { select: { id: true, razonSocial: true, rfc: true } },
  items: {
    include: { menuItem: { select: { id: true, nombre: true } } },
    orderBy: { createdAt: "asc" as const },
  },
} as const;

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "RESTAURANTE", req);

  const estado = searchParams.get("estado");
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  const ordenes = await prisma.restOrden.findMany({
    where: {
      companyId,
      ...(estado ? { estado: estado as "ABIERTA" | "COBRADA" | "CANCELADA" } : {}),
      ...(from || to
        ? {
            createdAt: {
              gte: from ? new Date(from) : undefined,
              lt: to ? new Date(to) : undefined,
            },
          }
        : {}),
    },
    include: ordenInclude,
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return NextResponse.json(ordenes);
});

const itemSchema = z.object({
  menuItemId: z.string().min(1),
  cantidad: z.number().positive(),
  notas: z.string().max(300).nullable().optional(),
});

const createSchema = z.object({
  companyId: z.string().min(1),
  tipo: z.enum(["MESA", "LLEVAR", "DOMICILIO"]).default("MESA"),
  mesa: z.string().max(40).nullable().optional(),
  comensales: z.number().int().positive().nullable().optional(),
  clienteNombre: z.string().max(120).nullable().optional(),
  notas: z.string().max(500).nullable().optional(),
  items: z.array(itemSchema).min(1),
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, items, ...data } = parsed.data;

  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "RESTAURANTE", req);

  const menuItemIds = [...new Set(items.map((i) => i.menuItemId))];
  const menuItems = await prisma.restMenuItem.findMany({
    where: { id: { in: menuItemIds }, companyId },
    select: { id: true, precio: true, estacion: true, activo: true, disponible: true, nombre: true },
  });
  const menuMap = new Map(menuItems.map((m) => [m.id, m]));
  if (menuMap.size !== menuItemIds.length) {
    return NextResponse.json({ error: "Platillo inválido en la orden" }, { status: 400 });
  }
  const noDisponible = items.find((i) => {
    const m = menuMap.get(i.menuItemId)!;
    return !m.activo || !m.disponible;
  });
  if (noDisponible) {
    return NextResponse.json(
      { error: `«${menuMap.get(noDisponible.menuItemId)!.nombre}» no está disponible` },
      { status: 422 }
    );
  }

  const orden = await prisma.$transaction(async (tx) => {
    const last = await tx.restOrden.findFirst({
      where: { companyId },
      orderBy: { folio: "desc" },
      select: { folio: true },
    });
    const folio = (last?.folio ?? 0) + 1;

    return tx.restOrden.create({
      data: {
        companyId,
        folio,
        meseroUserId: user.id,
        ...data,
        items: {
          create: items.map((i) => {
            const m = menuMap.get(i.menuItemId)!;
            return {
              menuItemId: i.menuItemId,
              cantidad: i.cantidad,
              precioUnitario: m.precio,
              estacion: m.estacion,
              notas: i.notas ?? null,
            };
          }),
        },
      },
      include: ordenInclude,
    });
  });

  return NextResponse.json(orden, { status: 201 });
});
