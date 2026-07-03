import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireOwner } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";

type Params = { params: Promise<{ id: string; userId: string }> };

const updateSchema = z.object({
  role: z.enum(["OWNER", "ADMIN", "ACCOUNTANT", "VIEWER"] as const),
});

// PATCH /api/companies/[id]/members/[userId] — change role
export async function PATCH(req: Request, { params }: Params) {
  try {
    const { id: companyId, userId } = await params;
    const { user: actor } = await requireOwner(companyId);

    const body = await req.json().catch(() => null);
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Rol inválido" }, { status: 400 });
    }

    // Don't let the only owner demote themselves
    if (userId === actor.id && parsed.data.role !== "OWNER") {
      const ownerCount = await prisma.companyMember.count({
        where: { companyId, role: "OWNER" },
      });
      if (ownerCount <= 1) {
        return NextResponse.json(
          { error: "Debe quedar al menos un OWNER en la empresa" },
          { status: 400 }
        );
      }
    }

    const updated = await prisma.companyMember.update({
      where: { userId_companyId: { userId, companyId } },
      data: { role: parsed.data.role },
    });

    // Bitácora de seguridad: cambio de rol (fire-and-forget).
    registrarBitacora({
      companyId,
      userId: actor.id,
      actorEmail: actor.email,
      accion: "miembros.cambiar-rol",
      entidad: "CompanyMember",
      entidadId: updated.id,
      detalle: { miembroUserId: userId, nuevoRol: updated.role },
      req,
    });

    return NextResponse.json({ id: updated.id, role: updated.role });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

// DELETE /api/companies/[id]/members/[userId] — remove member
export async function DELETE(req: Request, { params }: Params) {
  try {
    const { id: companyId, userId } = await params;
    const { user: actor } = await requireOwner(companyId);

    // Block removing the last owner
    const target = await prisma.companyMember.findUnique({
      where: { userId_companyId: { userId, companyId } },
    });
    if (!target) return NextResponse.json({ error: "Miembro no encontrado" }, { status: 404 });

    if (target.role === "OWNER") {
      const ownerCount = await prisma.companyMember.count({
        where: { companyId, role: "OWNER" },
      });
      if (ownerCount <= 1) {
        return NextResponse.json(
          { error: "Debe quedar al menos un OWNER en la empresa" },
          { status: 400 }
        );
      }
    }

    // Self-removal allowed but warn that they lose access
    void actor;

    await prisma.companyMember.delete({
      where: { userId_companyId: { userId, companyId } },
    });

    // Bitácora de seguridad: baja de miembro (fire-and-forget).
    registrarBitacora({
      companyId,
      userId: actor.id,
      actorEmail: actor.email,
      accion: "miembros.eliminar",
      entidad: "CompanyMember",
      entidadId: target.id,
      detalle: { miembroUserId: userId, rolAnterior: target.role },
      req,
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
