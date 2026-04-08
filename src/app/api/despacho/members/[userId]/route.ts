import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError } from "@/lib/authz";
import { requireDespachoRole } from "@/lib/despacho";

type Params = { params: Promise<{ userId: string }> };

const updateSchema = z.object({
  role: z.enum(["OWNER", "ADMIN", "ACCOUNTANT"] as const),
});

// PATCH /api/despacho/members/[userId] — change member role
export async function PATCH(req: Request, { params }: Params) {
  try {
    const access = await requireDespachoRole(["OWNER", "ADMIN"]);
    const { userId } = await params;

    const parsed = updateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "Rol inválido" }, { status: 400 });
    }

    // Don't let the only owner demote themselves
    if (userId === access.userId && parsed.data.role !== "OWNER") {
      const ownerCount = await prisma.despachoMember.count({
        where: { despachoId: access.despachoId, role: "OWNER" },
      });
      if (ownerCount <= 1) {
        return NextResponse.json(
          { error: "Debe quedar al menos un OWNER en el despacho" },
          { status: 400 }
        );
      }
    }

    // Find the target membership
    const target = await prisma.despachoMember.findFirst({
      where: { despachoId: access.despachoId, userId },
    });
    if (!target) return NextResponse.json({ error: "Miembro no encontrado" }, { status: 404 });

    const updated = await prisma.despachoMember.update({
      where: { id: target.id },
      data: { role: parsed.data.role },
    });

    return NextResponse.json({ id: updated.id, role: updated.role });
  } catch (e) {
    if (e instanceof AuthzError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}

// DELETE /api/despacho/members/[userId] — remove from despacho
export async function DELETE(_req: Request, { params }: Params) {
  try {
    const access = await requireDespachoRole(["OWNER", "ADMIN"]);
    const { userId } = await params;

    const target = await prisma.despachoMember.findFirst({
      where: { despachoId: access.despachoId, userId },
    });
    if (!target) return NextResponse.json({ error: "Miembro no encontrado" }, { status: 404 });

    // Block removing the last owner
    if (target.role === "OWNER") {
      const ownerCount = await prisma.despachoMember.count({
        where: { despachoId: access.despachoId, role: "OWNER" },
      });
      if (ownerCount <= 1) {
        return NextResponse.json(
          { error: "Debe quedar al menos un OWNER en el despacho" },
          { status: 400 }
        );
      }
    }

    await prisma.despachoMember.delete({ where: { id: target.id } });

    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthzError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
