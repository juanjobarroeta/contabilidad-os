/**
 * PUT    /api/hospital/puestos/[id] { nombre, descripcion?, todasLasPaginas, paginas[], permisos[] }
 *        Guarda el puesto y recalcula, en la misma transacción, el acceso de
 *        todos sus miembros. Si algún miembro es administrador (o el propio
 *        actor), sólo el dueño lo cambia: cambiar el puesto es cambiar su acceso.
 * DELETE /api/hospital/puestos/[id] — sólo sin miembros (409 si los tiene).
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, withAuthz } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";
import { puestoSchema, recalcularMiembros } from "@/lib/hospital/puestos";

type Params = { params: Promise<{ id: string }> };

async function contexto(id: string, req: Request) {
  const puesto = await prisma.hospPuesto.findUnique({ where: { id }, include: { miembros: { select: { userId: true, role: true } } } });
  if (!puesto) throw new AuthzError(404, "Puesto no encontrado");
  const { user, membership } = await requireMembership(puesto.companyId, ["OWNER", "ADMIN"], req);
  await requireModule(puesto.companyId, "HOSPITAL", req);
  return { puesto, user, actorRole: membership.role };
}

export const PUT = withAuthz(async (req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const parsed = puestoSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos" }, { status: 400 });
  const { puesto, user, actorRole } = await contexto(id, req);
  const d = parsed.data;
  if (!d.todasLasPaginas && d.paginas.length === 0) {
    return NextResponse.json({ error: "Elige al menos una página o marca «todas las páginas»." }, { status: 400 });
  }
  if (actorRole !== "OWNER") {
    if (puesto.miembros.some((m) => m.userId === user.id)) throw new AuthzError(403, "Tienes este puesto: no puedes cambiar tu propio acceso. Pídeselo al dueño.");
    if (puesto.miembros.some((m) => m.role === "ADMIN" || m.role === "OWNER")) throw new AuthzError(403, "Un administrador tiene este puesto: sólo el dueño lo cambia.");
  }
  if (d.nombre !== puesto.nombre) {
    const otro = await prisma.hospPuesto.findUnique({ where: { companyId_nombre: { companyId: puesto.companyId, nombre: d.nombre } }, select: { id: true } });
    if (otro) return NextResponse.json({ error: `Ya existe el puesto «${d.nombre}»` }, { status: 409 });
  }
  const r = await prisma.$transaction(async (tx) => {
    const p = await tx.hospPuesto.update({
      where: { id },
      data: { nombre: d.nombre, descripcion: d.descripcion ?? null, todasLasPaginas: d.todasLasPaginas, paginas: d.todasLasPaginas ? [] : d.paginas, permisos: d.permisos },
    });
    const actualizados = await recalcularMiembros(tx, id);
    return { ...p, miembros: actualizados, actualizados };
  });
  registrarBitacora({
    companyId: puesto.companyId, userId: user.id, actorEmail: user.email, accion: "hospital.puesto.editar", entidad: "HospPuesto", entidadId: id,
    detalle: { antes: { paginas: puesto.paginas, permisos: puesto.permisos, todasLasPaginas: puesto.todasLasPaginas }, despues: d, miembrosRecalculados: r.actualizados }, req,
  });
  return NextResponse.json(r);
});

export const DELETE = withAuthz(async (req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const { puesto, user } = await contexto(id, req);
  if (puesto.miembros.length) {
    return NextResponse.json({ error: `${puesto.miembros.length} ${puesto.miembros.length === 1 ? "usuario tiene" : "usuarios tienen"} este puesto: reasígnalos antes de borrarlo.` }, { status: 409 });
  }
  await prisma.hospPuesto.delete({ where: { id } });
  registrarBitacora({ companyId: puesto.companyId, userId: user.id, actorEmail: user.email, accion: "hospital.puesto.borrar", entidad: "HospPuesto", entidadId: id, detalle: { nombre: puesto.nombre }, req });
  return NextResponse.json({ ok: true });
});
