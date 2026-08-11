import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";

// ─────────────────────────────────────────────────────────────────────────────
// GET/PATCH /api/automotriz/prospectos/[id] — seguimiento del prospecto.
// PATCH mueve el pipeline (estado) y actualiza datos/próxima acción. Reglas:
//   - GANADO exige clienteId (el Customer canónico) y sella ganadoAt; puede
//     ligar pedidoId (el pipeline de venta sigue en Pedidos).
//   - PERDIDO sella perdidoAt y pide el motivo.
//   - Reabrir (GANADO/PERDIDO → abierto) limpia los sellos.
// ─────────────────────────────────────────────────────────────────────────────

const incluye = {
  vendedor: { select: { id: true, nombre: true, apellidoPaterno: true } },
  vehiculo: { select: { id: true, vin: true, marca: true, modelo: true, anio: true, estado: true } },
  cliente: { select: { id: true, razonSocial: true } },
  pedido: { select: { id: true, estado: true, precio: true } },
} as const;

const ABIERTOS = ["NUEVO", "CONTACTADO", "CITA", "DEMO", "NEGOCIACION"] as const;

export const GET = withAuthz(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const prospecto = await prisma.prospecto.findUnique({ where: { id }, include: incluye });
  if (!prospecto) throw new AuthzError(404, "Prospecto no encontrado");
  await requireMembership(prospecto.companyId, undefined, req);
  await requireModule(prospecto.companyId, "AUTOMOTRIZ", req);
  return NextResponse.json(prospecto);
});

const patchSchema = z.object({
  estado: z.enum(["NUEVO", "CONTACTADO", "CITA", "DEMO", "NEGOCIACION", "GANADO", "PERDIDO"]).optional(),
  nombre: z.string().min(1).max(200).optional(),
  telefono: z.string().max(30).nullable().optional(),
  email: z.string().email().max(200).nullable().optional(),
  medio: z.enum(["PISO", "TELEFONO", "DIGITAL", "REFERIDO", "OTRO"]).optional(),
  interes: z.string().max(300).nullable().optional(),
  vehiculoId: z.string().nullable().optional(),
  vendedorId: z.string().nullable().optional(),
  proximaAccion: z.string().datetime().nullable().optional(),
  proximaNota: z.string().max(300).nullable().optional(),
  notas: z.string().max(4000).nullable().optional(),
  clienteId: z.string().nullable().optional(),
  pedidoId: z.string().nullable().optional(),
  perdidoMotivo: z.string().max(300).nullable().optional(),
});

export const PATCH = withAuthz(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;

  const prospecto = await prisma.prospecto.findUnique({
    where: { id },
    select: { companyId: true, estado: true, clienteId: true },
  });
  if (!prospecto) throw new AuthzError(404, "Prospecto no encontrado");
  await requireWriter(prospecto.companyId, req);
  await requireModule(prospecto.companyId, "AUTOMOTRIZ", req);

  // Validación de referencias cruzadas (todas de la misma empresa).
  const refs: Array<[string | null | undefined, () => Promise<{ companyId: string } | null>]> = [
    [d.vendedorId, () => prisma.employee.findUnique({ where: { id: d.vendedorId! }, select: { companyId: true } })],
    [d.vehiculoId, () => prisma.vehiculo.findUnique({ where: { id: d.vehiculoId! }, select: { companyId: true } })],
    [d.clienteId, () => prisma.customer.findUnique({ where: { id: d.clienteId! }, select: { companyId: true } })],
    [d.pedidoId, () => prisma.pedidoVehiculo.findUnique({ where: { id: d.pedidoId! }, select: { companyId: true } })],
  ];
  for (const [valor, buscar] of refs) {
    if (!valor) continue;
    const row = await buscar();
    if (!row || row.companyId !== prospecto.companyId) {
      return NextResponse.json({ error: "Referencia inválida (vendedor/unidad/cliente/pedido)" }, { status: 400 });
    }
  }

  const sellos: Record<string, unknown> = {};
  if (d.estado && d.estado !== prospecto.estado) {
    if (d.estado === "GANADO") {
      const clienteId = d.clienteId ?? prospecto.clienteId;
      if (!clienteId) {
        return NextResponse.json(
          { error: "Para marcar GANADO liga el cliente (clienteId) — el prospecto se convirtió en Customer" },
          { status: 422 }
        );
      }
      sellos.ganadoAt = new Date();
      sellos.perdidoAt = null;
    } else if (d.estado === "PERDIDO") {
      sellos.perdidoAt = new Date();
      sellos.ganadoAt = null;
    } else if ((ABIERTOS as readonly string[]).includes(d.estado)) {
      sellos.ganadoAt = null;
      sellos.perdidoAt = null;
      sellos.perdidoMotivo = null;
    }
  }

  const actualizado = await prisma.prospecto.update({
    where: { id },
    data: {
      ...(d.estado !== undefined ? { estado: d.estado } : {}),
      ...(d.nombre !== undefined ? { nombre: d.nombre.trim() } : {}),
      ...(d.telefono !== undefined ? { telefono: d.telefono?.trim() || null } : {}),
      ...(d.email !== undefined ? { email: d.email?.trim() || null } : {}),
      ...(d.medio !== undefined ? { medio: d.medio } : {}),
      ...(d.interes !== undefined ? { interes: d.interes?.trim() || null } : {}),
      ...(d.vehiculoId !== undefined ? { vehiculoId: d.vehiculoId } : {}),
      ...(d.vendedorId !== undefined ? { vendedorId: d.vendedorId } : {}),
      ...(d.proximaAccion !== undefined
        ? { proximaAccion: d.proximaAccion ? new Date(d.proximaAccion) : null }
        : {}),
      ...(d.proximaNota !== undefined ? { proximaNota: d.proximaNota?.trim() || null } : {}),
      ...(d.notas !== undefined ? { notas: d.notas } : {}),
      ...(d.clienteId !== undefined ? { clienteId: d.clienteId } : {}),
      ...(d.pedidoId !== undefined ? { pedidoId: d.pedidoId } : {}),
      ...(d.perdidoMotivo !== undefined ? { perdidoMotivo: d.perdidoMotivo?.trim() || null } : {}),
      ...sellos,
    },
    include: incluye,
  });
  return NextResponse.json(actualizado);
});
