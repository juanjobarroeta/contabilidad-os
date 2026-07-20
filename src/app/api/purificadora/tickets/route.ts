import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { parseFechaCorte } from "@/lib/purificadora/cortes";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// GET /api/purificadora/tickets?companyId=xxx&fecha=YYYY-MM-DD[&estado=]
// Los tickets de ventanilla del día (para la vista de la vendedora y para el
// resumen que Minerva revisa en el corte).
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "PURIFICADORA", req);

  const fechaStr = searchParams.get("fecha");
  const fecha = fechaStr ? parseFechaCorte(fechaStr) : null;
  if (fechaStr && !fecha) return NextResponse.json({ error: "Fecha inválida" }, { status: 400 });

  const estado = searchParams.get("estado");

  const tickets = await prisma.purifTicket.findMany({
    where: {
      companyId,
      ...(fecha ? { fecha } : {}),
      ...(estado === "REGISTRADO" || estado === "INTEGRADO" || estado === "CANCELADO"
        ? { estado }
        : {}),
    },
    include: { items: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  // Resumen del día por forma de pago (sólo REGISTRADOS = pendientes de corte).
  const pendientes = tickets.filter((t) => t.estado === "REGISTRADO");
  const resumen = {
    tickets: pendientes.length,
    efectivo: round2(
      pendientes.filter((t) => t.formaPago === "EFECTIVO").reduce((s, t) => s + t.total, 0)
    ),
    // Tarjeta y transferencia caen al banco: en el corte viajan juntas.
    banco: round2(
      pendientes
        .filter((t) => t.formaPago === "TRANSFERENCIA" || t.formaPago === "TARJETA")
        .reduce((s, t) => s + t.total, 0)
    ),
    garrafones: pendientes.reduce((s, t) => s + t.garrafones, 0),
    total: round2(pendientes.reduce((s, t) => s + t.total, 0)),
  };

  return NextResponse.json({ tickets, resumen });
});

const createSchema = z.object({
  companyId: z.string().min(1),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  formaPago: z.enum(["EFECTIVO", "TRANSFERENCIA", "TARJETA"]),
  items: z
    .array(
      z.object({
        productoId: z.string().min(1),
        cantidad: z.number().positive(),
      })
    )
    .min(1),
  notas: z.string().trim().max(300).nullish(),
});

// POST /api/purificadora/tickets — cobro rápido de ventanilla.
// Los precios y el factor de garrafones se toman SIEMPRE del catálogo (la
// vendedora no captura precios). No postea contabilidad: queda REGISTRADO
// hasta que el corte del día se confirma.
export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, formaPago, items, notas } = parsed.data;
  const fecha = parseFechaCorte(parsed.data.fecha);
  if (!fecha) return NextResponse.json({ error: "Fecha inválida" }, { status: 400 });

  await requireWriter(companyId, req);
  await requireModule(companyId, "PURIFICADORA", req);

  const productoIds = [...new Set(items.map((i) => i.productoId))];
  const productos = await prisma.purifProducto.findMany({
    where: { id: { in: productoIds }, companyId, activo: true },
  });
  const productoById = new Map(productos.map((p) => [p.id, p]));
  for (const id of productoIds) {
    if (!productoById.has(id)) {
      return NextResponse.json({ error: "Producto inválido o inactivo" }, { status: 400 });
    }
  }

  const partidas = items.map((i) => {
    const p = productoById.get(i.productoId)!;
    return {
      productoId: p.id,
      descripcion: p.nombre,
      cantidad: i.cantidad,
      precioUnitario: p.precio,
      importe: round2(i.cantidad * p.precio),
      garrafones: Math.round(i.cantidad * p.garrafones),
    };
  });
  const total = round2(partidas.reduce((s, p) => s + p.importe, 0));
  const garrafones = partidas.reduce((s, p) => s + p.garrafones, 0);
  if (!(total > 0)) {
    return NextResponse.json({ error: "El total del ticket debe ser mayor a 0" }, { status: 400 });
  }

  const ticket = await prisma.purifTicket.create({
    data: {
      companyId,
      fecha,
      formaPago,
      total,
      garrafones,
      notas: notas ?? null,
      items: { create: partidas },
    },
    include: { items: true },
  });

  return NextResponse.json(ticket, { status: 201 });
});
