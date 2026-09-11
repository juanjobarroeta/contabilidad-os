import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, isOperador, requireUser } from "@/lib/authz";

// GET /api/juridico/conversaciones — las conversaciones del copiloto jurídico
// del usuario (sólo operador por ahora: es la superficie de prueba de
// docs/MOTOR-JURIDICO.md §6). Sin mensajes; sólo el encabezado del hilo.
export async function GET(req: Request) {
  let usuario: { id: string };
  try {
    usuario = await requireUser(req);
  } catch (e) {
    return NextResponse.json({ error: e instanceof AuthzError ? e.message : "Unauthorized" }, { status: e instanceof AuthzError ? e.status : 401 });
  }
  if (!(await isOperador(usuario.id))) return NextResponse.json({ error: "Sólo el operador" }, { status: 403 });

  const convs = await prisma.juridicoConversacion.findMany({
    where: { userId: usuario.id, archivedAt: null },
    orderBy: { updatedAt: "desc" },
    take: 200,
    select: { id: true, titulo: true, updatedAt: true, _count: { select: { mensajes: true } } },
  });
  return NextResponse.json(convs.map((c) => ({ id: c.id, titulo: c.titulo, updatedAt: c.updatedAt, mensajes: c._count.mensajes })));
}
