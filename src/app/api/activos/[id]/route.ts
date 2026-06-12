import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { TASA_DEPRECIACION, type TipoActivo } from "@/lib/fiscal/depreciacion";

const TIPOS = Object.keys(TASA_DEPRECIACION) as TipoActivo[];

// PATCH /api/activos/[id] — editar tipo, MOI, fecha, tope, o registrar baja.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const activo = await prisma.activoFijo.findUnique({ where: { id }, select: { id: true, companyId: true } });
  if (!activo) return NextResponse.json({ error: "Activo no encontrado" }, { status: 404 });
  const member = await getEffectiveCompanyMembership(session.user.id, activo.companyId);
  if (!member || member.role === "VIEWER") return NextResponse.json({ error: "Sin permisos" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const data: Record<string, unknown> = {};
  if (typeof body.descripcion === "string" && body.descripcion.trim()) data.descripcion = body.descripcion.trim();
  if (TIPOS.includes(body.tipo)) {
    data.tipo = body.tipo;
    data.tasaAnual = TASA_DEPRECIACION[body.tipo as TipoActivo].tasa;
  }
  if (typeof body.tasaAnual === "number" && body.tasaAnual > 0 && body.tasaAnual <= 1) data.tasaAnual = body.tasaAnual;
  if (typeof body.moi === "number" && body.moi > 0) data.moi = body.moi;
  if (body.fechaAdquisicion) data.fechaAdquisicion = new Date(body.fechaAdquisicion);
  if (typeof body.esAutomovil === "boolean") data.esAutomovil = body.esAutomovil;
  if (typeof body.esElectricoHibrido === "boolean") data.esElectricoHibrido = body.esElectricoHibrido;
  if ("fechaBaja" in body) {
    data.fechaBaja = body.fechaBaja ? new Date(body.fechaBaja) : null;
    if ("motivoBaja" in body) data.motivoBaja = body.motivoBaja?.trim() || null;
  }
  if (Object.keys(data).length === 0) return NextResponse.json({ error: "No hay cambios" }, { status: 400 });

  // Editarlo = el contador ya lo revisó → quita la bandera de auto-creado.
  data.autoCreado = false;

  const updated = await prisma.activoFijo.update({ where: { id }, data });
  return NextResponse.json(updated);
}

// DELETE /api/activos/[id]
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const activo = await prisma.activoFijo.findUnique({ where: { id }, select: { id: true, companyId: true } });
  if (!activo) return NextResponse.json({ error: "Activo no encontrado" }, { status: 404 });
  const member = await getEffectiveCompanyMembership(session.user.id, activo.companyId);
  if (!member || member.role === "VIEWER") return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  await prisma.activoFijo.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
