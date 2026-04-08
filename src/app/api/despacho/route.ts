import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthzError } from "@/lib/authz";
import { requireDespachoRole, requireOwnDespacho } from "@/lib/despacho";
import { prisma } from "@/lib/prisma";

// GET /api/despacho — current user's despacho (or 404 if none)
export async function GET() {
  try {
    const access = await requireOwnDespacho();
    const despacho = await prisma.despacho.findUnique({
      where: { id: access.despachoId },
      include: {
        _count: { select: { members: true, companies: true } },
      },
    });
    return NextResponse.json({
      ...despacho,
      myRole: access.role,
    });
  } catch (e) {
    if (e instanceof AuthzError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}

// PATCH /api/despacho — rename despacho (OWNER/ADMIN only)
const patchSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export async function PATCH(req: Request) {
  try {
    const access = await requireDespachoRole(["OWNER", "ADMIN"]);
    const parsed = patchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "Nombre inválido" }, { status: 400 });
    }
    const updated = await prisma.despacho.update({
      where: { id: access.despachoId },
      data: { name: parsed.data.name },
    });
    return NextResponse.json(updated);
  } catch (e) {
    if (e instanceof AuthzError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
