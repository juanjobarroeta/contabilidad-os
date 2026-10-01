import { PERMISOS_CLINICOS } from "@/lib/hospital/permisos";
import { accesoEfectivo, ajustesSchema, validarRolYPermisos } from "@/lib/hospital/puestos";
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, withAuthz } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("permisos"),
    role: z.enum(["ADMIN", "ACCOUNTANT", "VIEWER"]),
    // Llaves de página del satélite; [] = ve todas.
    permisosClinicos: z.array(z.enum(PERMISOS_CLINICOS)).optional(),
    paginas: z.array(z.string().trim().min(1).max(40)).max(64).default([]),
  }),
  z.object({
    // Puesto + ajustes: el acceso completo en un solo guardado (páginas y
    // permisos efectivos salen de lib/hospital/puestos.ts).
    action: z.literal("acceso"),
    // OWNER sólo vale para el propio dueño (su rol no cambia desde aquí).
    role: z.enum(["OWNER", "ADMIN", "ACCOUNTANT", "VIEWER"]),
    puestoId: z.string().min(1).nullable(),
    ajustes: ajustesSchema,
  }),
  z.object({
    action: z.literal("password"),
    password: z.string().min(8, "Mínimo 8 caracteres").max(200),
  }),
  z.object({
    action: z.literal("nombre"),
    nombre: z.string().trim().min(1).max(120),
  }),
]);

// Reglas comunes a editar/eliminar miembros desde el satélite (mismas que
// automotriz/usuarios):
//   - Sólo OWNER/ADMIN de la empresa.
//   - Al OWNER nadie lo toca desde aquí (se administra en contabilidadOS).
//   - Nadie edita su propia membresía (evita quedarse fuera); la contraseña
//     propia sí se puede cambiar.
//   - A un ADMIN sólo lo modifica el OWNER.
async function cargarContexto(id: string, req: Request) {
  const target = await prisma.companyMember.findUnique({
    where: { id },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  if (!target) throw new AuthzError(404, "Usuario no encontrado");

  const { user: actor, membership } = await requireMembership(
    target.companyId,
    ["OWNER", "ADMIN"],
    req
  );
  await requireModule(target.companyId, "HOSPITAL", req);
  return { target, actor, actorRole: membership.role };
}

function validarJerarquia(
  target: { role: string; userId: string },
  actor: { id: string },
  actorRole: string,
  { permitirSelf = false } = {}
) {
  if (target.role === "OWNER") {
    throw new AuthzError(403, "El dueño de la empresa se administra en contabilidadOS.");
  }
  if (target.userId === actor.id && !permitirSelf) {
    throw new AuthzError(403, "No puedes modificar tu propia cuenta desde aquí.");
  }
  if (target.role === "ADMIN" && actorRole !== "OWNER" && target.userId !== actor.id) {
    throw new AuthzError(403, "Sólo el dueño puede modificar a otro administrador.");
  }
}

// PATCH /api/hospital/usuarios/[id] — id = membershipId.
//   permisos  → rol + páginas visibles del satélite (la rejilla)
//   password  → nueva contraseña (aplica también en contabilidadOS: es la cuenta)
//   nombre    → renombra al usuario
export const PATCH = withAuthz(async (req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "Datos inválidos";
    return NextResponse.json({ error: first }, { status: 400 });
  }
  const { target, actor, actorRole } = await cargarContexto(id, req);
  const data = parsed.data;

  switch (data.action) {
    case "permisos": {
      validarJerarquia(target, actor, actorRole);
      if (data.role === "ADMIN" && actorRole !== "OWNER") {
        return NextResponse.json(
          { error: "Sólo el dueño puede nombrar administradores." },
          { status: 403 }
        );
      }
      const updated = await prisma.companyMember.update({
        where: { id },
        data: { role: data.role, hospitalPaginas: data.paginas, hospitalPermisos: data.permisosClinicos },
      });
      registrarBitacora({
        companyId: target.companyId,
        userId: actor.id,
        actorEmail: actor.email,
        accion: "usuario.permisos",
        entidad: "CompanyMember",
        entidadId: id,
        detalle: {
          email: target.user.email,
          rolAnterior: target.role,
          rol: updated.role,
          paginas: updated.hospitalPaginas,
          permisosClinicos: updated.hospitalPermisos,
          origen: "hospital",
        },
        req,
      });
      return NextResponse.json({
        ok: true,
        role: updated.role,
        paginas: updated.hospitalPaginas,
          permisosClinicos: updated.hospitalPermisos,
        sinRestriccion: updated.hospitalPaginas.length === 0,
      });
    }

    case "acceso": {
      // El dueño sí ajusta su propio acceso (es quien puede); nadie más se
      // edita a sí mismo, y a un administrador sólo lo cambia el dueño.
      const esDuenoSobreSi = actorRole === "OWNER" && target.userId === actor.id;
      if (!esDuenoSobreSi) validarJerarquia(target, actor, actorRole);
      if (data.role === "OWNER" && target.role !== "OWNER") {
        return NextResponse.json({ error: "El dueño se cambia en ContabilidadOS." }, { status: 403 });
      }
      const role = target.role === "OWNER" ? "OWNER" : data.role;
      if (role === "ADMIN" && target.role !== "ADMIN" && actorRole !== "OWNER") {
        return NextResponse.json({ error: "Sólo el dueño puede nombrar administradores." }, { status: 403 });
      }
      let puesto = null;
      if (data.puestoId) {
        puesto = await prisma.hospPuesto.findUnique({ where: { id: data.puestoId } });
        if (!puesto || puesto.companyId !== target.companyId) return NextResponse.json({ error: "Puesto no encontrado" }, { status: 404 });
      }
      // A la medida (sin puesto): los «extra» son todo su acceso.
      const ef = accesoEfectivo(puesto, puesto ? data.ajustes : { ...data.ajustes, paginasQuitadas: [], permisosQuitados: [] });
      validarRolYPermisos(role, ef.permisos);
      const updated = await prisma.companyMember.update({
        where: { id },
        data: {
          role,
          hospitalPuestoId: puesto?.id ?? null,
          hospitalAjustes: data.ajustes,
          hospitalPaginas: ef.paginas,
          hospitalPermisos: ef.permisos,
        },
      });
      registrarBitacora({
        companyId: target.companyId,
        userId: actor.id,
        actorEmail: actor.email,
        accion: "usuario.acceso",
        entidad: "CompanyMember",
        entidadId: id,
        detalle: {
          email: target.user.email,
          rolAnterior: target.role,
          rol: role,
          puestoAnterior: target.hospitalPuestoId,
          puesto: puesto?.nombre ?? null,
          ajustes: data.ajustes,
          paginasAntes: target.hospitalPaginas,
          paginas: ef.paginas,
          permisosAntes: target.hospitalPermisos,
          permisos: ef.permisos,
          origen: "hospital",
        },
        req,
      });
      return NextResponse.json({ ok: true, role: updated.role, puestoId: updated.hospitalPuestoId, paginas: ef.paginas, permisosClinicos: ef.permisos });
    }

    case "password": {
      validarJerarquia(target, actor, actorRole, { permitirSelf: true });
      const hashed = await bcrypt.hash(data.password, 10);
      await prisma.user.update({ where: { id: target.userId }, data: { password: hashed } });
      registrarBitacora({
        companyId: target.companyId,
        userId: actor.id,
        actorEmail: actor.email,
        accion: "usuario.password",
        entidad: "CompanyMember",
        entidadId: id,
        detalle: { email: target.user.email, origen: "hospital" },
        req,
      });
      return NextResponse.json({ ok: true });
    }

    case "nombre": {
      validarJerarquia(target, actor, actorRole, { permitirSelf: true });
      await prisma.user.update({ where: { id: target.userId }, data: { name: data.nombre } });
      registrarBitacora({
        companyId: target.companyId,
        userId: actor.id,
        actorEmail: actor.email,
        accion: "usuario.renombrar",
        entidad: "CompanyMember",
        entidadId: id,
        detalle: { email: target.user.email, nombre: data.nombre, origen: "hospital" },
        req,
      });
      return NextResponse.json({ ok: true });
    }
  }
});

// DELETE /api/hospital/usuarios/[id] — quita el acceso a la empresa.
// La cuenta (User) no se borra: puede tener membresías en otras empresas y
// su historial en bitácora; simplemente deja de poder entrar aquí.
export const DELETE = withAuthz(async (req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const { target, actor, actorRole } = await cargarContexto(id, req);
  validarJerarquia(target, actor, actorRole);

  await prisma.companyMember.delete({ where: { id } });
  registrarBitacora({
    companyId: target.companyId,
    userId: actor.id,
    actorEmail: actor.email,
    accion: "usuario.eliminar",
    entidad: "CompanyMember",
    entidadId: id,
    detalle: { email: target.user.email, origen: "hospital" },
    req,
  });
  return NextResponse.json({ ok: true });
});
