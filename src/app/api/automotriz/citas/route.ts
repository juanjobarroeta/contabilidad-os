import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";

// ─────────────────────────────────────────────────────────────────────────────
// GET/POST /api/automotriz/citas — la agenda del taller.
// El cliente agenda desde su portal (canal PORTAL, nace PENDIENTE); el taller
// agenda por teléfono/mostrador aquí (canal STAFF, nace CONFIRMADA — crearla
// ES confirmarla). R1 sin modelo de capacidad: el «confirmar» humano es la
// compuerta. Al llegar la unidad, POST [id]/recibir la convierte en orden.
// ─────────────────────────────────────────────────────────────────────────────

const incluye = {
  customer: { select: { id: true, razonSocial: true, phone: true } },
  vehiculo: { select: { id: true, vin: true, marca: true, modelo: true, anio: true } },
  orden: { select: { id: true, folio: true, estado: true } },
} as const;

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  const desde = searchParams.get("desde");
  const hasta = searchParams.get("hasta");
  const estado = searchParams.get("estado");
  const abiertas = searchParams.get("abiertas") === "1";

  const where: Prisma.CitaServicioWhereInput = {
    companyId,
    ...(estado ? { estado: estado as never } : {}),
    ...(abiertas ? { estado: { in: ["PENDIENTE", "CONFIRMADA"] } } : {}),
    ...(desde || hasta
      ? {
          fecha: {
            ...(desde ? { gte: new Date(desde) } : {}),
            ...(hasta ? { lt: new Date(hasta) } : {}),
          },
        }
      : {}),
  };

  const [citas, conteos] = await Promise.all([
    prisma.citaServicio.findMany({ where, include: incluye, orderBy: { fecha: "asc" }, take: 200 }),
    prisma.citaServicio.groupBy({ by: ["estado"], where: { companyId }, _count: { _all: true } }),
  ]);

  return NextResponse.json({
    citas,
    porEstado: Object.fromEntries(conteos.map((c) => [c.estado, c._count._all])),
  });
});

const createSchema = z.object({
  companyId: z.string().min(1),
  customerId: z.string().nullable().optional(),
  clienteNombre: z.string().max(200).nullable().optional(),
  telefono: z.string().max(30).nullable().optional(),
  vehiculoId: z.string().nullable().optional(),
  vin: z.string().max(17).nullable().optional(),
  descripcionUnidad: z.string().max(200).nullable().optional(),
  placas: z.string().max(20).nullable().optional(),
  fecha: z.string().datetime(),
  motivo: z.string().min(1).max(2000),
  notas: z.string().max(2000).nullable().optional(),
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;

  const { user } = await requireWriter(d.companyId, req);
  await requireModule(d.companyId, "AUTOMOTRIZ", req);

  if (d.customerId) {
    const cliente = await prisma.customer.findUnique({ where: { id: d.customerId }, select: { companyId: true } });
    if (!cliente || cliente.companyId !== d.companyId) {
      return NextResponse.json({ error: "customerId inválido" }, { status: 400 });
    }
  }
  if (d.vehiculoId) {
    const veh = await prisma.vehiculo.findUnique({ where: { id: d.vehiculoId }, select: { companyId: true } });
    if (!veh || veh.companyId !== d.companyId) {
      return NextResponse.json({ error: "vehiculoId inválido" }, { status: 400 });
    }
  }

  const cita = await prisma.citaServicio.create({
    data: {
      companyId: d.companyId,
      canal: "STAFF",
      estado: "CONFIRMADA", // el taller la crea = el taller la confirma
      confirmadaAt: new Date(),
      customerId: d.customerId ?? null,
      clienteNombre: d.clienteNombre?.trim() || null,
      telefono: d.telefono?.trim() || null,
      vehiculoId: d.vehiculoId ?? null,
      vin: d.vin?.trim().toUpperCase() || null,
      descripcionUnidad: d.descripcionUnidad ?? null,
      placas: d.placas?.trim().toUpperCase() || null,
      fecha: new Date(d.fecha),
      motivo: d.motivo,
      notas: d.notas ?? null,
    },
    include: incluye,
  });

  registrarBitacora({
    companyId: d.companyId,
    userId: user.id,
    actorEmail: user.email,
    accion: "automotriz.cita.crear",
    entidad: "CitaServicio",
    entidadId: cita.id,
    detalle: { canal: "STAFF", fecha: d.fecha, motivo: d.motivo.slice(0, 120) },
  });

  return NextResponse.json(cita, { status: 201 });
});
