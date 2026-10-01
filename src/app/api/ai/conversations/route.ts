import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { conversacionDeNota, pendientesAbiertas } from "@/lib/expediente/notas";

// GET /api/ai/conversations?companyId=xxx
// Lista las conversaciones visibles para el usuario en la empresa: las suyas
// (cualquier visibilidad) + las COMPARTIDAS (COMPANY) del equipo. Más recientes
// primero. No incluye los mensajes (sólo el encabezado del hilo, el último
// mensaje como `snippet` y si quedó `pending`).
//
// `pending`: la conversación terminó con algo sin resolver — una propuesta que
// nunca se confirmó (pendingAction sigue puesto) o un compromiso abierto en el
// expediente que salió de ella. Es lo que el chat ofrece «retomar».
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const [convs, abiertas] = await Promise.all([
    prisma.chatConversation.findMany({
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
        pendingAction: true,
        user: { select: { name: true, email: true } },
        messages: { orderBy: { createdAt: "desc" }, take: 1, select: { content: true } },
      },
    }),
    pendientesAbiertas(companyId, 100).catch(() => []),
  ]);

  const conPendiente = new Set(abiertas.map(conversacionDeNota).filter((x): x is string => !!x));

  return NextResponse.json(
    convs.map((c) => ({
      id: c.id,
      title: c.title,
      visibility: c.visibility,
      updatedAt: c.updatedAt,
      mine: c.userId === session.user!.id,
      autor: c.user?.name ?? c.user?.email ?? null,
      pending: c.pendingAction != null || conPendiente.has(c.id),
      snippet: (c.messages[0]?.content ?? "").replace(/\s+/g, " ").trim().slice(0, 140),
    }))
  );
}
