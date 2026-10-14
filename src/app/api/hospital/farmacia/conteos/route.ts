import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod, usuarioDe } from "@/lib/hospital/http";

// ─────────────────────────────────────────────────────────────────────────────
// GET  /api/hospital/farmacia/conteos?companyId=   → sesiones abiertas y recientes, y los almacenes
//      que existen (con cuántos lotes con existencia), para elegir cuál se cuenta o a cuál se recibe
// POST /api/hospital/farmacia/conteos  { companyId, almacen?, notas? } → abre una sesión
//
// Conteo físico con escáner (ver lib/hospital/conteo-db.ts).
// ─────────────────────────────────────────────────────────────────────────────

export const GET = withHospital(async (req: Request) => {
  const companyId = new URL(req.url).searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);
  const conteos = await prisma.hospConteo.findMany({
    where: { companyId },
    orderBy: [{ estado: "asc" }, { createdAt: "desc" }],
    take: 30,
    select: { id: true, almacen: true, estado: true, notas: true, createdAt: true, iniciadoPorNombre: true, cerradoAt: true, cerradoPorNombre: true, _count: { select: { lineas: true } } },
  });
  // El almacén se escribe tal cual quedó en los lotes («GENERAL», «ALMACEN GENERAL»…): se elige de aquí, no se teclea.
  const almacenes = await prisma.hospLote.groupBy({
    by: ["almacen"],
    where: { companyId },
    _count: { _all: true },
    orderBy: { _count: { almacen: "desc" } },
  });
  return NextResponse.json({
    conteos: conteos.map(({ _count, ...c }) => ({ ...c, lineas: _count.lineas })),
    almacenes: almacenes.map((a) => ({ almacen: a.almacen, lotes: a._count._all })),
  });
});

const schema = z.object({
  companyId: z.string().min(1),
  almacen: z.string().trim().min(1).max(60).optional(),
  notas: z.string().trim().max(300).optional(),
});

export const POST = withHospital(async (req: Request) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorZod(parsed.error);
  const { companyId, notas } = parsed.data;
  const almacen = parsed.data.almacen ?? "GENERAL";
  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);
  const abierto = await prisma.hospConteo.findFirst({ where: { companyId, almacen, estado: "ABIERTO" }, select: { id: true } });
  if (abierto) return NextResponse.json({ conteo: { id: abierto.id }, yaAbierto: true });
  const u = usuarioDe(user);
  const conteo = await prisma.hospConteo.create({ data: { companyId, almacen, notas: notas ?? null, iniciadoPorId: u.id, iniciadoPorNombre: u.nombre } });
  bitacora(user, req, { companyId, accion: "hospital.conteo.abrir", entidad: "HospConteo", entidadId: conteo.id, detalle: { almacen } });
  return NextResponse.json({ conteo: { id: conteo.id } }, { status: 201 });
});
