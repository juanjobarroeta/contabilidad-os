import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isOperador } from "@/lib/authz";

// GET /api/juridico/conversaciones — las conversaciones del copiloto jurídico
// del usuario (sólo operador por ahora: es la superficie de prueba de
// docs/MOTOR-JURIDICO.md §6). Sin mensajes; sólo el encabezado del hilo.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await isOperador(session.user.id))) return NextResponse.json({ error: "Sólo el operador" }, { status: 403 });

  const convs = await prisma.juridicoConversacion.findMany({
    where: { userId: session.user.id, archivedAt: null },
    orderBy: { updatedAt: "desc" },
    take: 200,
    select: { id: true, titulo: true, updatedAt: true, _count: { select: { mensajes: true } } },
  });
  return NextResponse.json(convs.map((c) => ({ id: c.id, titulo: c.titulo, updatedAt: c.updatedAt, mensajes: c._count.mensajes })));
}
