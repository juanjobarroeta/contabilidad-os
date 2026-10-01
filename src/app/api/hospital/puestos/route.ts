/**
 * GET  /api/hospital/puestos?companyId=  → { puestos: [{ …, miembros }] }
 * POST /api/hospital/puestos { companyId, nombre, descripcion?, todasLasPaginas, paginas[], permisos[] } → 201
 *
 * Puestos = roles vivos del hospital (lib/hospital/puestos.ts). Los crean y
 * editan el dueño y los administradores. Las llaves de página son del
 * satélite; el hub las guarda tal cual.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";
import { puestoSchema } from "@/lib/hospital/puestos";

export const GET = withAuthz(async (req: Request) => {
  const companyId = new URL(req.url).searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  await requireMembership(companyId, ["OWNER", "ADMIN"], req);
  await requireModule(companyId, "HOSPITAL", req);
  const puestos = await prisma.hospPuesto.findMany({
    where: { companyId },
    include: { _count: { select: { miembros: true } } },
    orderBy: { nombre: "asc" },
  });
  return NextResponse.json({
    puestos: puestos.map(({ _count, ...p }) => ({ ...p, miembros: _count.miembros })),
  });
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const companyId = typeof body?.companyId === "string" ? body.companyId : "";
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  const parsed = puestoSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos" }, { status: 400 });
  const { user } = await requireMembership(companyId, ["OWNER", "ADMIN"], req);
  await requireModule(companyId, "HOSPITAL", req);
  const d = parsed.data;
  if (!d.todasLasPaginas && d.paginas.length === 0) {
    return NextResponse.json({ error: "Elige al menos una página o marca «todas las páginas»." }, { status: 400 });
  }
  const existe = await prisma.hospPuesto.findUnique({ where: { companyId_nombre: { companyId, nombre: d.nombre } }, select: { id: true } });
  if (existe) return NextResponse.json({ error: `Ya existe el puesto «${d.nombre}»` }, { status: 409 });
  const puesto = await prisma.hospPuesto.create({
    data: { companyId, nombre: d.nombre, descripcion: d.descripcion ?? null, todasLasPaginas: d.todasLasPaginas, paginas: d.todasLasPaginas ? [] : d.paginas, permisos: d.permisos },
  });
  registrarBitacora({ companyId, userId: user.id, actorEmail: user.email, accion: "hospital.puesto.crear", entidad: "HospPuesto", entidadId: puesto.id, detalle: d, req });
  return NextResponse.json({ ...puesto, miembros: 0 }, { status: 201 });
});
