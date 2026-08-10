import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";

// ─────────────────────────────────────────────────────────────────────────────
// GET/POST /api/automotriz/pedidos — el pipeline de venta (ROADMAP §4.2):
// COTIZACION → APARTADO → FACTURADO → ENTREGADO (+CANCELADO). El pedido
// captura la negociación (precio, enganche/anticipo, toma a cuenta,
// financiamiento); NO postea al ledger — el dinero entra por conciliación
// bancaria y el asiento de la venta lo hace facturar (lib/automotriz/venta).
// ─────────────────────────────────────────────────────────────────────────────

const incluye = {
  vehiculo: { select: { id: true, vin: true, marca: true, modelo: true, anio: true, estado: true, precioLista: true } },
  cliente: { select: { id: true, razonSocial: true, rfc: true, phone: true } },
  vendedor: { select: { id: true, nombre: true, apellidoPaterno: true } },
} as const;

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  const estado = searchParams.get("estado");
  const pedidos = await prisma.pedidoVehiculo.findMany({
    where: { companyId, ...(estado ? { estado: estado as never } : {}) },
    include: incluye,
    orderBy: { updatedAt: "desc" },
  });

  const conteos = await prisma.pedidoVehiculo.groupBy({
    by: ["estado"],
    where: { companyId },
    _count: { _all: true },
  });

  return NextResponse.json({
    pedidos,
    porEstado: Object.fromEntries(conteos.map((c) => [c.estado, c._count._all])),
  });
});

const createSchema = z.object({
  companyId: z.string().min(1),
  vehiculoId: z.string().min(1),
  clienteId: z.string().min(1),
  vendedorId: z.string().nullable().optional(),
  precio: z.number().positive(),
  enganche: z.number().min(0).optional(),
  anticipoRecibido: z.number().min(0).optional(),
  tomaACuentaDesc: z.string().max(300).nullable().optional(),
  tomaACuentaMonto: z.number().min(0).nullable().optional(),
  financiamiento: z.string().max(500).nullable().optional(),
  notas: z.string().max(4000).nullable().optional(),
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;

  await requireWriter(d.companyId, req);
  await requireModule(d.companyId, "AUTOMOTRIZ", req);

  const [vehiculo, cliente] = await Promise.all([
    prisma.vehiculo.findUnique({ where: { id: d.vehiculoId }, select: { companyId: true, estado: true } }),
    prisma.customer.findUnique({ where: { id: d.clienteId }, select: { companyId: true } }),
  ]);
  if (!vehiculo || vehiculo.companyId !== d.companyId) {
    return NextResponse.json({ error: "vehiculoId inválido" }, { status: 400 });
  }
  if (!cliente || cliente.companyId !== d.companyId) {
    return NextResponse.json({ error: "clienteId inválido" }, { status: 400 });
  }
  if (vehiculo.estado !== "DISPONIBLE" && vehiculo.estado !== "APARTADO" && vehiculo.estado !== "EN_TRANSITO") {
    return NextResponse.json(
      { error: `La unidad no está disponible para pedido (estado: ${vehiculo.estado})` },
      { status: 422 }
    );
  }
  if (d.vendedorId) {
    const emp = await prisma.employee.findUnique({ where: { id: d.vendedorId }, select: { companyId: true } });
    if (!emp || emp.companyId !== d.companyId) {
      return NextResponse.json({ error: "vendedorId inválido" }, { status: 400 });
    }
  }

  // Un pedido vivo por unidad: evita vender dos veces el mismo VIN.
  const vivo = await prisma.pedidoVehiculo.findFirst({
    where: { vehiculoId: d.vehiculoId, estado: { in: ["COTIZACION", "APARTADO", "FACTURADO"] } },
    select: { id: true },
  });
  if (vivo) {
    return NextResponse.json({ error: "La unidad ya tiene un pedido activo" }, { status: 422 });
  }

  const pedido = await prisma.pedidoVehiculo.create({
    data: {
      companyId: d.companyId,
      vehiculoId: d.vehiculoId,
      clienteId: d.clienteId,
      vendedorId: d.vendedorId ?? null,
      precio: d.precio,
      enganche: d.enganche ?? 0,
      anticipoRecibido: d.anticipoRecibido ?? 0,
      tomaACuentaDesc: d.tomaACuentaDesc ?? null,
      tomaACuentaMonto: d.tomaACuentaMonto ?? null,
      financiamiento: d.financiamiento ?? null,
      notas: d.notas ?? null,
    },
    include: incluye,
  });
  return NextResponse.json(pedido, { status: 201 });
});
