import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";

// ─────────────────────────────────────────────────────────────────────────────
// GET/POST /api/automotriz/ordenes — órdenes de servicio del taller (fase 5b):
// RECIBIDA → EN_PROCESO → LISTA → ENTREGADA (+CANCELADA). La orden es el
// documento OPERATIVO (falla, diagnóstico, presupuesto); el CFDI del cierre
// llega por el sync y el derivador la liga solo (ServicioVenta) — aquí no se
// captura ni se postea nada.
// ─────────────────────────────────────────────────────────────────────────────

const incluye = {
  cliente: { select: { id: true, razonSocial: true, phone: true } },
  vehiculo: { select: { id: true, vin: true, marca: true, modelo: true, anio: true } },
  asesor: { select: { id: true, nombre: true, apellidoPaterno: true } },
  tecnico: { select: { id: true, nombre: true, apellidoPaterno: true } },
  servicioVenta: { select: { id: true, invoiceId: true, total: true, fecha: true } },
  lineas: true,
} as const;

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  const estado = searchParams.get("estado");
  const q = searchParams.get("q")?.trim();
  const abiertas = searchParams.get("abiertas") === "1";

  const where: Prisma.OrdenServicioWhereInput = {
    companyId,
    ...(estado ? { estado: estado as never } : {}),
    ...(abiertas ? { estado: { in: ["RECIBIDA", "EN_PROCESO", "LISTA"] } } : {}),
    ...(q
      ? {
          OR: [
            ...(Number.isInteger(Number(q)) && Number(q) > 0 ? [{ folio: Number(q) }] : []),
            { vin: { contains: q, mode: "insensitive" as const } },
            { placas: { contains: q, mode: "insensitive" as const } },
            { descripcionUnidad: { contains: q, mode: "insensitive" as const } },
            { cliente: { razonSocial: { contains: q, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };

  const [ordenes, conteos] = await Promise.all([
    prisma.ordenServicio.findMany({ where, include: incluye, orderBy: { recibidaAt: "desc" }, take: 200 }),
    prisma.ordenServicio.groupBy({ by: ["estado"], where: { companyId }, _count: { _all: true } }),
  ]);

  return NextResponse.json({
    ordenes,
    porEstado: Object.fromEntries(conteos.map((c) => [c.estado, c._count._all])),
  });
});

const lineaSchema = z.object({
  tipo: z.enum(["MANO_OBRA", "REFACCION"]),
  descripcion: z.string().min(1).max(300),
  cantidad: z.number().positive().default(1),
  precioUnitario: z.number().min(0).default(0),
  refaccionId: z.string().nullable().optional(),
});

const createSchema = z.object({
  companyId: z.string().min(1),
  clienteId: z.string().nullable().optional(),
  vin: z.string().max(17).nullable().optional(),
  descripcionUnidad: z.string().max(200).nullable().optional(),
  placas: z.string().max(20).nullable().optional(),
  kilometraje: z.number().int().min(0).nullable().optional(),
  fallaReportada: z.string().min(1).max(4000),
  asesorId: z.string().nullable().optional(),
  tecnicoId: z.string().nullable().optional(),
  prometidaAt: z.string().datetime().nullable().optional(),
  notas: z.string().max(4000).nullable().optional(),
  lineas: z.array(lineaSchema).max(50).optional(),
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;

  await requireWriter(d.companyId, req);
  await requireModule(d.companyId, "AUTOMOTRIZ", req);

  if (d.clienteId) {
    const cliente = await prisma.customer.findUnique({ where: { id: d.clienteId }, select: { companyId: true } });
    if (!cliente || cliente.companyId !== d.companyId) {
      return NextResponse.json({ error: "clienteId inválido" }, { status: 400 });
    }
  }
  for (const empId of [d.asesorId, d.tecnicoId]) {
    if (!empId) continue;
    const emp = await prisma.employee.findUnique({ where: { id: empId }, select: { companyId: true } });
    if (!emp || emp.companyId !== d.companyId) {
      return NextResponse.json({ error: "asesorId/tecnicoId inválido" }, { status: 400 });
    }
  }

  // Si el VIN recibido existe en el inventario propio, la orden liga la unidad.
  const vin = d.vin?.trim().toUpperCase() || null;
  let vehiculoId: string | null = null;
  if (vin && vin.length === 17) {
    const unidad = await prisma.vehiculo.findUnique({
      where: { companyId_vin: { companyId: d.companyId, vin } },
      select: { id: true },
    });
    vehiculoId = unidad?.id ?? null;
  }

  // Folio consecutivo por empresa. El unique [companyId, folio] cierra la
  // carrera: si dos recepciones chocan, la segunda reintenta.
  for (let intento = 0; ; intento++) {
    const max = await prisma.ordenServicio.aggregate({
      where: { companyId: d.companyId },
      _max: { folio: true },
    });
    try {
      const orden = await prisma.ordenServicio.create({
        data: {
          companyId: d.companyId,
          folio: (max._max.folio ?? 0) + 1,
          clienteId: d.clienteId ?? null,
          vehiculoId,
          vin,
          descripcionUnidad: d.descripcionUnidad ?? null,
          placas: d.placas?.trim().toUpperCase() || null,
          kilometraje: d.kilometraje ?? null,
          fallaReportada: d.fallaReportada,
          asesorId: d.asesorId ?? null,
          tecnicoId: d.tecnicoId ?? null,
          prometidaAt: d.prometidaAt ? new Date(d.prometidaAt) : null,
          notas: d.notas ?? null,
          lineas: d.lineas?.length
            ? {
                create: d.lineas.map((l) => ({
                  tipo: l.tipo,
                  descripcion: l.descripcion,
                  cantidad: l.cantidad,
                  precioUnitario: l.precioUnitario,
                  refaccionId: l.refaccionId ?? null,
                })),
              }
            : undefined,
        },
        include: incluye,
      });
      return NextResponse.json(orden, { status: 201 });
    } catch (e) {
      const esChoqueFolio =
        e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && intento < 3;
      if (!esChoqueFolio) throw e;
    }
  }
});
