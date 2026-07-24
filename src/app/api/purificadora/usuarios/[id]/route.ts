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
    // Puesto del empleado restringido; null = módulo completo.
    // soloVentanilla (boolean) se acepta por compatibilidad → VENTANILLA.
    puesto: z.enum(["VENTANILLA", "REPARTO", "AMBOS"]).nullish(),
    soloVentanilla: z.boolean().optional(),
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

// Reglas comunes a editar/eliminar miembros desde el satélite:
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
  await requireModule(target.companyId, "PURIFICADORA", req);
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

// PATCH /api/purificadora/usuarios/[id] — id = membershipId.
//   permisos  → cambia rol y restricción "sólo ventanilla"
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
      // Puesto = operativo encajonado al módulo purificadora (ventanilla,
      // reparto o ambos). Cualquier otro rol va sin restricción.
      const puesto =
        data.role === "ACCOUNTANT"
          ? data.puesto ?? (data.soloVentanilla ? ("VENTANILLA" as const) : null)
          : null;
      const updated = await prisma.companyMember.update({
        where: { id },
        data: {
          role: data.role,
          allowedModules: puesto ? ["PURIFICADORA"] : [],
          purifPuesto: puesto,
        },
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
          puesto,
        },
      });
      return NextResponse.json({
        ok: true,
        role: updated.role,
        allowedModules: updated.allowedModules,
        puesto: updated.purifPuesto,
      });
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
        detalle: { email: target.user.email },
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
        detalle: { email: target.user.email, nombre: data.nombre },
      });
      return NextResponse.json({ ok: true });
    }
  }
});

// DELETE /api/purificadora/usuarios/[id] — quita el acceso a la empresa.
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
    detalle: { email: target.user.email, rolAnterior: target.role },
  });
  return NextResponse.json({ ok: true });
});
