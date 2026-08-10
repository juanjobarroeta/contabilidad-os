import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";

const incluye = {
  vehiculo: { select: { id: true, vin: true, marca: true, modelo: true, anio: true, estado: true, precioLista: true, costoCompra: true } },
  cliente: { select: { id: true, razonSocial: true, rfc: true, phone: true, email: true } },
  vendedor: { select: { id: true, nombre: true, apellidoPaterno: true } },
} as const;

export const GET = withAuthz(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const pedido = await prisma.pedidoVehiculo.findUnique({ where: { id }, include: incluye });
  if (!pedido) throw new AuthzError(404, "Pedido no encontrado");
  await requireMembership(pedido.companyId, undefined, req);
  await requireModule(pedido.companyId, "AUTOMOTRIZ", req);
  return NextResponse.json(pedido);
});

const patchSchema = z.object({
  precio: z.number().positive().optional(),
  enganche: z.number().min(0).optional(),
  anticipoRecibido: z.number().min(0).optional(),
  tomaACuentaDesc: z.string().max(300).nullable().optional(),
  tomaACuentaMonto: z.number().min(0).nullable().optional(),
  financiamiento: z.string().max(500).nullable().optional(),
  notas: z.string().max(4000).nullable().optional(),
  vendedorId: z.string().nullable().optional(),
});

export const PATCH = withAuthz(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const pedido = await prisma.pedidoVehiculo.findUnique({ where: { id }, select: { companyId: true, estado: true } });
  if (!pedido) throw new AuthzError(404, "Pedido no encontrado");
  await requireWriter(pedido.companyId, req);
  await requireModule(pedido.companyId, "AUTOMOTRIZ", req);

  if (pedido.estado === "FACTURADO" || pedido.estado === "ENTREGADO" || pedido.estado === "CANCELADO") {
    return NextResponse.json({ error: `Un pedido ${pedido.estado} ya no se edita` }, { status: 422 });
  }
  if (parsed.data.vendedorId) {
    const emp = await prisma.employee.findUnique({ where: { id: parsed.data.vendedorId }, select: { companyId: true } });
    if (!emp || emp.companyId !== pedido.companyId) {
      return NextResponse.json({ error: "vendedorId inválido" }, { status: 400 });
    }
  }

  const updated = await prisma.pedidoVehiculo.update({ where: { id }, data: parsed.data, include: incluye });
  return NextResponse.json(updated);
});
