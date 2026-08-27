import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { camposRecepcion, datosRecepcion } from "@/lib/automotriz/recepcion";

// ─────────────────────────────────────────────────────────────────────────────
// GET/PATCH /api/automotriz/ordenes/[id] — detalle y edición de la orden.
// PATCH edita el contenido operativo (diagnóstico, técnico, promesa, líneas);
// las transiciones de estado van por /accion.
// ─────────────────────────────────────────────────────────────────────────────

const incluye = {
  cliente: { select: { id: true, razonSocial: true, rfc: true, phone: true, email: true } },
  vehiculo: { select: { id: true, vin: true, marca: true, modelo: true, anio: true, color: true } },
  asesor: { select: { id: true, nombre: true, apellidoPaterno: true } },
  tecnico: { select: { id: true, nombre: true, apellidoPaterno: true } },
  servicioVenta: {
    select: {
      id: true,
      total: true,
      manoObra: true,
      refacciones: true,
      fecha: true,
      invoice: { select: { id: true, serie: true, folio: true, uuid: true } },
    },
  },
  lineas: { include: { refaccion: { select: { id: true, numeroParte: true, ultimoCosto: true } } } },
  documentos: { select: { id: true, tipo: true, nombre: true, mime: true, bytes: true, createdAt: true } },
  cita: { select: { id: true, fecha: true, canal: true, motivo: true } },
} as const;

export const GET = withAuthz(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const orden = await prisma.ordenServicio.findUnique({ where: { id }, include: incluye });
  if (!orden) throw new AuthzError(404, "Orden no encontrada");
  await requireMembership(orden.companyId, undefined, req);
  await requireModule(orden.companyId, "AUTOMOTRIZ", req);
  return NextResponse.json(orden);
});

const lineaSchema = z.object({
  tipo: z.enum(["MANO_OBRA", "REFACCION"]),
  descripcion: z.string().min(1).max(300),
  cantidad: z.number().positive().default(1),
  precioUnitario: z.number().min(0).default(0),
  refaccionId: z.string().nullable().optional(),
});

const patchSchema = z.object({
  diagnostico: z.string().max(4000).nullable().optional(),
  notas: z.string().max(4000).nullable().optional(),
  kilometraje: z.number().int().min(0).nullable().optional(),
  tecnicoId: z.string().nullable().optional(),
  asesorId: z.string().nullable().optional(),
  clienteId: z.string().nullable().optional(),
  prometidaAt: z.string().datetime().nullable().optional(),
  /** Reemplaza TODAS las líneas del presupuesto. */
  lineas: z.array(lineaSchema).max(50).optional(),
  ...camposRecepcion,
});

export const PATCH = withAuthz(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;

  const orden = await prisma.ordenServicio.findUnique({
    where: { id },
    select: { companyId: true, estado: true },
  });
  if (!orden) throw new AuthzError(404, "Orden no encontrada");
  await requireWriter(orden.companyId, req);
  await requireModule(orden.companyId, "AUTOMOTRIZ", req);

  if (orden.estado === "ENTREGADA" || orden.estado === "CANCELADA") {
    return NextResponse.json({ error: `Una orden ${orden.estado} ya no se edita` }, { status: 422 });
  }

  for (const empId of [d.tecnicoId, d.asesorId]) {
    if (!empId) continue;
    const emp = await prisma.employee.findUnique({ where: { id: empId }, select: { companyId: true } });
    if (!emp || emp.companyId !== orden.companyId) {
      return NextResponse.json({ error: "tecnicoId/asesorId inválido" }, { status: 400 });
    }
  }
  if (d.clienteId) {
    const cliente = await prisma.customer.findUnique({ where: { id: d.clienteId }, select: { companyId: true } });
    if (!cliente || cliente.companyId !== orden.companyId) {
      return NextResponse.json({ error: "clienteId inválido" }, { status: 400 });
    }
  }

  const actualizada = await prisma.$transaction(async (tx) => {
    if (d.lineas) {
      await tx.ordenServicioLinea.deleteMany({ where: { ordenId: id } });
      if (d.lineas.length) {
        await tx.ordenServicioLinea.createMany({
          data: d.lineas.map((l) => ({
            ordenId: id,
            tipo: l.tipo,
            descripcion: l.descripcion,
            cantidad: l.cantidad,
            precioUnitario: l.precioUnitario,
            refaccionId: l.refaccionId ?? null,
          })),
        });
      }
    }
    return tx.ordenServicio.update({
      where: { id },
      data: {
        ...(d.diagnostico !== undefined ? { diagnostico: d.diagnostico } : {}),
        ...(d.notas !== undefined ? { notas: d.notas } : {}),
        ...(d.kilometraje !== undefined ? { kilometraje: d.kilometraje } : {}),
        ...(d.tecnicoId !== undefined ? { tecnicoId: d.tecnicoId } : {}),
        ...(d.asesorId !== undefined ? { asesorId: d.asesorId } : {}),
        ...(d.clienteId !== undefined ? { clienteId: d.clienteId } : {}),
        ...(d.prometidaAt !== undefined
          ? { prometidaAt: d.prometidaAt ? new Date(d.prometidaAt) : null }
          : {}),
        ...datosRecepcion(d),
      },
      include: incluye,
    });
  });
  return NextResponse.json(actualizada);
});
