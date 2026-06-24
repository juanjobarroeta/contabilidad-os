import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";

// GET /api/ai/conversations?companyId=xxx
// Lista las conversaciones visibles para el usuario en la empresa: las suyas
// (cualquier visibilidad) + las COMPARTIDAS (COMPANY) del equipo. Más recientes
// primero. No incluye los mensajes (sólo el encabezado del hilo).
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const convs = await prisma.chatConversation.findMany({
    where: {
      companyId,
      archivedAt: null,
      OR: [{ userId: session.user.id }, { visibility: "COMPANY" }],
    },
    orderBy: { updatedAt: "desc" },
    take: 100,
    select: {
      id: true,
      title: true,
      visibility: true,
      updatedAt: true,
      userId: true,
      user: { select: { name: true, email: true } },
    },
  });

  return NextResponse.json(
    convs.map((c) => ({
      id: c.id,
      title: c.title,
      visibility: c.visibility,
      updatedAt: c.updatedAt,
      mine: c.userId === session.user!.id,
      autor: c.user?.name ?? c.user?.email ?? null,
    }))
  );
}
