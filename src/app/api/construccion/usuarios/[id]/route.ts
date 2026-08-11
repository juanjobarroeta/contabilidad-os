import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

/**
 * PATCH  /api/construccion/usuarios/[id]?companyId=  — cambiar rol de
 *        construcción o resetear contraseña de un miembro.
 * DELETE /api/construccion/usuarios/[id]?companyId=  — quitar el acceso del
 *        miembro a la empresa (no borra la cuenta).
 *
 * [id] es el CompanyMember.id. Guardas: sólo OWNER/ADMIN; nunca sobre un
 * OWNER; nunca sobre tu propia membresía (para el rol usa otra cuenta admin,
 * para tu contraseña usa /api/auth/change-password).
 */

const ROL = z.enum(["ADMIN", "TESORERIA", "RESIDENTE", "CONTABILIDAD"]);

const MEMBER_ROLE: Record<z.infer<typeof ROL>, "ADMIN" | "ACCOUNTANT"> = {
  ADMIN: "ADMIN",
  TESORERIA: "ACCOUNTANT",
  RESIDENTE: "ACCOUNTANT",
  CONTABILIDAD: "ACCOUNTANT",
};

const patchSchema = z
  .object({
    construccionRol: ROL.optional(),
    newPassword: z.string().min(8, "Mínimo 8 caracteres").max(200).optional(),
    name: z.string().trim().min(1).max(120).optional(),
  })
  .refine((d) => d.construccionRol || d.newPassword || d.name, {
    message: "Nada que actualizar",
  });

type Target = {
  id: string;
  companyId: string;
  role: string;
  userId: string;
  user: { id: string; esOperador: boolean };
};

async function loadTarget(
  req: Request,
  memberId: string
): Promise<{ error: Response | null; target: Target | null }> {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) {
    return { error: NextResponse.json({ error: "companyId requerido" }, { status: 400 }), target: null };
  }
  const { user: actor } = await requireMembership(companyId, ["OWNER", "ADMIN"], req);
  await requireModule(companyId, "CONSTRUCCION");

  const target = await prisma.companyMember.findUnique({
    where: { id: memberId },
    select: {
      id: true,
      companyId: true,
      role: true,
      userId: true,
      user: { select: { id: true, esOperador: true } },
    },
  });
  if (!target || target.companyId !== companyId) {
    return { error: NextResponse.json({ error: "Miembro no encontrado" }, { status: 404 }), target: null };
  }
  if (target.role === "OWNER" || target.user.esOperador) {
    return { error: NextResponse.json({ error: "No puedes modificar a un propietario" }, { status: 403 }), target: null };
  }
  if (target.userId === actor.id) {
    return { error: NextResponse.json({ error: "No puedes modificar tu propia membresía desde aquí" }, { status: 403 }), target: null };
  }
  return { error: null, target };
}

export const PATCH = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
    }
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Datos inválidos" },
        { status: 400 }
      );
    }

    const res = await loadTarget(req, id);
    if (res.error || !res.target) return res.error ?? NextResponse.json({ error: "Miembro no encontrado" }, { status: 404 });
    const target = res.target;

    const { construccionRol, newPassword, name } = parsed.data;

    if (construccionRol) {
      await prisma.companyMember.update({
        where: { id: target.id },
        data: { construccionRol, role: MEMBER_ROLE[construccionRol] },
      });
    }
    if (name) {
      await prisma.user.update({
        where: { id: target.userId },
        data: { name },
      });
    }
    if (newPassword) {
      await prisma.user.update({
        where: { id: target.userId },
        data: { password: await bcrypt.hash(newPassword, 10) },
      });
    }

    return NextResponse.json({ ok: true });
  }
);

export const DELETE = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const res = await loadTarget(req, id);
    if (res.error || !res.target) return res.error ?? NextResponse.json({ error: "Miembro no encontrado" }, { status: 404 });

    await prisma.companyMember.delete({ where: { id: res.target.id } });
    return NextResponse.json({ ok: true });
  }
);
