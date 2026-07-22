import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  activo: z.boolean().optional(),
  password: z.string().min(8, "Mínimo 8 caracteres").max(200).optional(),
});

// PATCH /api/purificadora/portal-accounts/[id] — suspender/reactivar o
// restablecer la contraseña de una cuenta de portal.
export const PATCH = withAuthz(async (req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "Datos inválidos";
    return NextResponse.json({ error: first }, { status: 400 });
  }

  const cuenta = await prisma.purifPortalAccount.findUnique({
    where: { id },
    select: { id: true, companyId: true, email: true },
  });
  if (!cuenta) throw new AuthzError(404, "Cuenta no encontrada");

  const { user: actor } = await requireWriter(cuenta.companyId, req);
  await requireModule(cuenta.companyId, "PURIFICADORA", req);

  const data: { activo?: boolean; passwordHash?: string } = {};
  if (parsed.data.activo !== undefined) data.activo = parsed.data.activo;
  if (parsed.data.password) data.passwordHash = await bcrypt.hash(parsed.data.password, 10);
  if (!Object.keys(data).length) {
    return NextResponse.json({ error: "Nada que actualizar" }, { status: 400 });
  }

  const updated = await prisma.purifPortalAccount.update({
    where: { id },
    data,
    select: { id: true, customerId: true, email: true, activo: true, lastLoginAt: true },
  });
  registrarBitacora({
    companyId: cuenta.companyId,
    userId: actor.id,
    actorEmail: actor.email,
    accion: "portal.actualizar",
    entidad: "PurifPortalAccount",
    entidadId: id,
    detalle: {
      email: cuenta.email,
      activo: parsed.data.activo,
      passwordReset: !!parsed.data.password,
    },
  });
  return NextResponse.json(updated);
});
