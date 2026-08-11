import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";

// ─────────────────────────────────────────────────────────────────────────────
// GET/POST /api/automotriz/prospectos — CRM de piso (fase 2): el registro de
// guardia. Cada visita/llamada/lead entra como prospecto y avanza el pipeline
// NUEVO → CONTACTADO → CITA → DEMO → NEGOCIACION → GANADO/PERDIDO.
// proximaAccion vencida = la lista de llamadas del vendedor.
// ─────────────────────────────────────────────────────────────────────────────

const ABIERTOS = ["NUEVO", "CONTACTADO", "CITA", "DEMO", "NEGOCIACION"] as const;

const incluye = {
  vendedor: { select: { id: true, nombre: true, apellidoPaterno: true } },
  vehiculo: { select: { id: true, vin: true, marca: true, modelo: true, anio: true, estado: true } },
  cliente: { select: { id: true, razonSocial: true } },
  pedido: { select: { id: true, estado: true, precio: true } },
} as const;

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  const estado = searchParams.get("estado");
  const q = searchParams.get("q")?.trim();
  const vencidos = searchParams.get("vencidos") === "1";

  const where: Prisma.ProspectoWhereInput = {
    companyId,
    ...(estado === "ABIERTOS" ? { estado: { in: [...ABIERTOS] } } : estado ? { estado: estado as never } : {}),
    ...(vencidos ? { estado: { in: [...ABIERTOS] }, proximaAccion: { lt: new Date() } } : {}),
    ...(q
      ? {
          OR: [
            { nombre: { contains: q, mode: "insensitive" as const } },
            { telefono: { contains: q } },
            { email: { contains: q, mode: "insensitive" as const } },
            { interes: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const inicioMes = new Date();
  inicioMes.setDate(1);
  inicioMes.setHours(0, 0, 0, 0);

  const [prospectos, conteos, delMes, vencidosCount] = await Promise.all([
    prisma.prospecto.findMany({
      where,
      include: incluye,
      orderBy: [{ proximaAccion: { sort: "asc", nulls: "last" } }, { updatedAt: "desc" }],
      take: 300,
    }),
    prisma.prospecto.groupBy({ by: ["estado"], where: { companyId }, _count: { _all: true } }),
    // Funnel del mes: entradas por medio y cierres.
    prisma.prospecto.groupBy({
      by: ["medio"],
      where: { companyId, createdAt: { gte: inicioMes } },
      _count: { _all: true },
    }),
    prisma.prospecto.count({
      where: { companyId, estado: { in: [...ABIERTOS] }, proximaAccion: { lt: new Date() } },
    }),
  ]);

  const [ganadosMes, perdidosMes] = await Promise.all([
    prisma.prospecto.count({ where: { companyId, ganadoAt: { gte: inicioMes } } }),
    prisma.prospecto.count({ where: { companyId, perdidoAt: { gte: inicioMes } } }),
  ]);

  return NextResponse.json({
    prospectos,
    porEstado: Object.fromEntries(conteos.map((c) => [c.estado, c._count._all])),
    vencidos: vencidosCount,
    mes: {
      nuevos: delMes.reduce((s, m) => s + m._count._all, 0),
      porMedio: Object.fromEntries(delMes.map((m) => [m.medio, m._count._all])),
      ganados: ganadosMes,
      perdidos: perdidosMes,
    },
  });
});

const createSchema = z.object({
  companyId: z.string().min(1),
  nombre: z.string().min(1).max(200),
  telefono: z.string().max(30).nullable().optional(),
  email: z.string().email().max(200).nullable().optional(),
  medio: z.enum(["PISO", "TELEFONO", "DIGITAL", "REFERIDO", "OTRO"]).optional(),
  interes: z.string().max(300).nullable().optional(),
  vehiculoId: z.string().nullable().optional(),
  vendedorId: z.string().nullable().optional(),
  proximaAccion: z.string().datetime().nullable().optional(),
  proximaNota: z.string().max(300).nullable().optional(),
  notas: z.string().max(4000).nullable().optional(),
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;

  await requireWriter(d.companyId, req);
  await requireModule(d.companyId, "AUTOMOTRIZ", req);

  if (d.vendedorId) {
    const emp = await prisma.employee.findUnique({ where: { id: d.vendedorId }, select: { companyId: true } });
    if (!emp || emp.companyId !== d.companyId) {
      return NextResponse.json({ error: "vendedorId inválido" }, { status: 400 });
    }
  }
  if (d.vehiculoId) {
    const v = await prisma.vehiculo.findUnique({ where: { id: d.vehiculoId }, select: { companyId: true } });
    if (!v || v.companyId !== d.companyId) {
      return NextResponse.json({ error: "vehiculoId inválido" }, { status: 400 });
    }
  }

  const prospecto = await prisma.prospecto.create({
    data: {
      companyId: d.companyId,
      nombre: d.nombre.trim(),
      telefono: d.telefono?.trim() || null,
      email: d.email?.trim() || null,
      medio: d.medio ?? "PISO",
      interes: d.interes?.trim() || null,
      vehiculoId: d.vehiculoId ?? null,
      vendedorId: d.vendedorId ?? null,
      proximaAccion: d.proximaAccion ? new Date(d.proximaAccion) : null,
      proximaNota: d.proximaNota?.trim() || null,
      notas: d.notas ?? null,
    },
    include: incluye,
  });
  return NextResponse.json(prospecto, { status: 201 });
});
