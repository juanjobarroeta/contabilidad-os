import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/automotriz/vehiculos/[id]/marcar-vendida — confirmación HUMANA de
// una venta que el CFDI no puede probar (típico: venta a público en general
// sin VIN en la factura; la unidad quedó «en piso improbable»).
//
// SÓLO DATOS: cambia estado a VENDIDO con fecha/precio/cliente opcionales y
// deja rastro en notas. NO postea pólizas (la factura real ya entró al ledger
// por el cierre mensual como todos los CFDIs), NO calcula ISAN ni comisión.
// La venta operativa con motor fiscal sigue siendo /vender y /pedidos.
// ─────────────────────────────────────────────────────────────────────────────

const schema = z.object({
  fechaVenta: z.string().datetime().optional(), // default: hoy (o estima el usuario)
  precioVenta: z.number().positive().nullable().optional(), // sin IVA; null = desconocido
  clienteId: z.string().nullable().optional(),
  nota: z.string().max(500).optional(),
});

export const POST = withAuthz(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;

  const unidad = await prisma.vehiculo.findUnique({
    where: { id },
    select: { companyId: true, estado: true, ventaInvoiceId: true, notas: true, pedidos: { where: { estado: { in: ["COTIZACION", "APARTADO", "FACTURADO"] } }, select: { id: true }, take: 1 } },
  });
  if (!unidad) throw new AuthzError(404, "Unidad no encontrada");
  await requireWriter(unidad.companyId, req);
  await requireModule(unidad.companyId, "AUTOMOTRIZ", req);

  if (unidad.estado !== "DISPONIBLE" && unidad.estado !== "APARTADO") {
    return NextResponse.json({ error: `La unidad ya no está en piso (${unidad.estado})` }, { status: 422 });
  }
  if (unidad.ventaInvoiceId) {
    return NextResponse.json(
      { error: "La unidad tiene CFDI de venta ligado — su venta ya está probada, no se marca a mano" },
      { status: 422 }
    );
  }
  if (unidad.pedidos.length) {
    return NextResponse.json(
      { error: "La unidad tiene un pedido activo — ciérralo por Pedidos (facturar/entregar)" },
      { status: 422 }
    );
  }
  if (d.clienteId) {
    const cliente = await prisma.customer.findUnique({ where: { id: d.clienteId }, select: { companyId: true } });
    if (!cliente || cliente.companyId !== unidad.companyId) {
      return NextResponse.json({ error: "clienteId inválido" }, { status: 400 });
    }
  }

  const sello = `Vendida confirmada manualmente (sin CFDI ligable) el ${new Date().toISOString().slice(0, 10)}${d.nota ? `: ${d.nota}` : ""}`;
  const actualizada = await prisma.vehiculo.update({
    where: { id },
    data: {
      estado: "VENDIDO",
      fechaVenta: d.fechaVenta ? new Date(d.fechaVenta) : new Date(),
      precioVenta: d.precioVenta ?? null,
      clienteId: d.clienteId ?? undefined,
      notas: unidad.notas ? `${unidad.notas}\n${sello}` : sello,
    },
    select: { id: true, vin: true, estado: true, fechaVenta: true, precioVenta: true },
  });
  return NextResponse.json(actualizada);
});
