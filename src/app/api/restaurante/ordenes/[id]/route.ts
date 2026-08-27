/**
 * GET   /api/restaurante/ordenes/[id]
 * PATCH /api/restaurante/ordenes/[id]
 *
 * PATCH on an open order supports:
 *   • scalar edits (mesa, comensales, clienteNombre, notas, tipo)
 *   • addItems: append items (prices frozen from the menu, kitchen PENDIENTE)
 *   • estado: "CANCELADA" (only while ABIERTA)
 *   • customerId: link the fiscal customer for invoicing
 * On a COBRADA order it additionally accepts:
 *   • invoiceId: link the stamped CFDI (the satellite stamps via
 *     POST /api/facturas and then links it here — validated to belong to
 *     the same company and to not be linked to another order)
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";

const ordenInclude = {
  customer: { select: { id: true, razonSocial: true, rfc: true } },
  invoice: { select: { id: true, uuid: true, serie: true, folio: true, total: true } },
  items: {
    include: { menuItem: { select: { id: true, nombre: true } } },
    orderBy: { createdAt: "asc" as const },
  },
} as const;

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const orden = await prisma.restOrden.findUnique({ where: { id }, include: ordenInclude });
    if (!orden) throw new AuthzError(404, "Orden no encontrada");

    await requireMembership(orden.companyId, undefined, req);
    await requireModule(orden.companyId, "RESTAURANTE", req);

    return NextResponse.json(orden);
  }
);

const addItemSchema = z.object({
  menuItemId: z.string().min(1),
  cantidad: z.number().positive(),
  notas: z.string().max(300).nullable().optional(),
});

const patchSchema = z.object({
  tipo: z.enum(["MESA", "LLEVAR", "DOMICILIO"]).optional(),
  mesa: z.string().max(40).nullable().optional(),
  comensales: z.number().int().positive().nullable().optional(),
  clienteNombre: z.string().max(120).nullable().optional(),
  notas: z.string().max(500).nullable().optional(),
  estado: z.literal("CANCELADA").optional(),
  customerId: z.string().nullable().optional(),
  invoiceId: z.string().optional(),
  addItems: z.array(addItemSchema).min(1).optional(),
});

export const PATCH = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const orden = await prisma.restOrden.findUnique({
      where: { id },
      select: { id: true, companyId: true, estado: true, invoiceId: true },
    });
    if (!orden) throw new AuthzError(404, "Orden no encontrada");

    await requireWriter(orden.companyId, req);
    await requireModule(orden.companyId, "RESTAURANTE", req);

    const { addItems, invoiceId, customerId, estado, ...scalars } = parsed.data;

    // invoiceId link: allowed on COBRADA orders (post-charge invoicing).
    if (invoiceId !== undefined) {
      if (orden.estado !== "COBRADA") {
        return NextResponse.json(
          { error: "Sólo se factura una orden ya cobrada" },
          { status: 422 }
        );
      }
      if (orden.invoiceId && orden.invoiceId !== invoiceId) {
        return NextResponse.json({ error: "La orden ya tiene factura ligada" }, { status: 409 });
      }
      const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        select: { companyId: true, restOrden: { select: { id: true } } },
      });
      if (!invoice || invoice.companyId !== orden.companyId) {
        return NextResponse.json({ error: "Factura inválida" }, { status: 400 });
      }
      if (invoice.restOrden && invoice.restOrden.id !== id) {
        return NextResponse.json(
          { error: "Esa factura ya está ligada a otra orden" },
          { status: 409 }
        );
      }
      const updated = await prisma.restOrden.update({
        where: { id },
        data: { invoiceId },
        include: ordenInclude,
      });
      return NextResponse.json(updated);
    }

    // Everything else requires an open order.
    if (orden.estado !== "ABIERTA") {
      return NextResponse.json(
        { error: `Una orden ${orden.estado} ya no se puede modificar` },
        { status: 422 }
      );
    }

    if (customerId) {
      const customer = await prisma.customer.findUnique({
        where: { id: customerId },
        select: { companyId: true },
      });
      if (!customer || customer.companyId !== orden.companyId) {
        return NextResponse.json({ error: "Cliente inválido" }, { status: 400 });
      }
    }

    let itemsCreate: Array<{
      menuItemId: string;
      cantidad: number;
      precioUnitario: number;
      estacion: "COCINA" | "BARRA" | "POSTRES";
      notas: string | null;
    }> = [];
    if (addItems) {
      const menuItemIds = [...new Set(addItems.map((i) => i.menuItemId))];
      const menuItems = await prisma.restMenuItem.findMany({
        where: { id: { in: menuItemIds }, companyId: orden.companyId },
        select: { id: true, precio: true, estacion: true, activo: true, disponible: true, nombre: true },
      });
      const menuMap = new Map(menuItems.map((m) => [m.id, m]));
      if (menuMap.size !== menuItemIds.length) {
        return NextResponse.json({ error: "Platillo inválido" }, { status: 400 });
      }
      const noDisponible = addItems.find((i) => {
        const m = menuMap.get(i.menuItemId)!;
        return !m.activo || !m.disponible;
      });
      if (noDisponible) {
        return NextResponse.json(
          { error: `«${menuMap.get(noDisponible.menuItemId)!.nombre}» no está disponible` },
          { status: 422 }
        );
      }
      itemsCreate = addItems.map((i) => {
        const m = menuMap.get(i.menuItemId)!;
        return {
          menuItemId: i.menuItemId,
          cantidad: i.cantidad,
          precioUnitario: Number(m.precio),
          estacion: m.estacion,
          notas: i.notas ?? null,
        };
      });
    }

    const updated = await prisma.restOrden.update({
      where: { id },
      data: {
        ...scalars,
        ...(customerId !== undefined ? { customerId } : {}),
        ...(estado ? { estado } : {}),
        ...(itemsCreate.length > 0 ? { items: { create: itemsCreate } } : {}),
      },
      include: ordenInclude,
    });

    return NextResponse.json(updated);
  }
);
