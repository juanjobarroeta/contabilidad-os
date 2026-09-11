import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, isOperador, requireUser } from "@/lib/authz";

async function cargar(id: string, userId: string) {
  const conv = await prisma.juridicoConversacion.findUnique({ where: { id }, select: { id: true, userId: true, titulo: true, archivedAt: true } });
  if (!conv || conv.userId !== userId || conv.archivedAt) return null;
  return conv;
}

// GET /api/juridico/conversaciones/[id] — el hilo completo con la traza de cada respuesta.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let usuario: { id: string };
  try {
    usuario = await requireUser(req);
  } catch (e) {
    return NextResponse.json({ error: e instanceof AuthzError ? e.message : "Unauthorized" }, { status: e instanceof AuthzError ? e.status : 401 });
  }
  if (!(await isOperador(usuario.id))) return NextResponse.json({ error: "Sólo el operador" }, { status: 403 });
  const { id } = await params;
  const conv = await cargar(id, usuario.id);
  if (!conv) return NextResponse.json({ error: "Conversación no encontrada" }, { status: 404 });
  const mensajes = await prisma.juridicoMensaje.findMany({
    where: { conversacionId: id },
    orderBy: { createdAt: "asc" },
    select: { id: true, rol: true, contenido: true, meta: true, feedback: true, correccion: true, createdAt: true },
  });
  return NextResponse.json({ id: conv.id, titulo: conv.titulo, mensajes });
}

// PATCH /api/juridico/conversaciones/[id] — feedback sobre una respuesta
// ({ mensajeId, feedback: "up"|"down"|null, correccion? }) o renombrar ({ titulo }).
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let usuario: { id: string };
  try {
    usuario = await requireUser(req);
  } catch (e) {
    return NextResponse.json({ error: e instanceof AuthzError ? e.message : "Unauthorized" }, { status: e instanceof AuthzError ? e.status : 401 });
  }
  if (!(await isOperador(usuario.id))) return NextResponse.json({ error: "Sólo el operador" }, { status: 403 });
  const { id } = await params;
  const conv = await cargar(id, usuario.id);
  if (!conv) return NextResponse.json({ error: "Conversación no encontrada" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { titulo?: unknown; mensajeId?: unknown; feedback?: unknown; correccion?: unknown };

  if (typeof body.titulo === "string" && body.titulo.trim()) {
    await prisma.juridicoConversacion.update({ where: { id }, data: { titulo: body.titulo.trim().slice(0, 120) } });
    return NextResponse.json({ ok: true });
  }
  if (typeof body.mensajeId === "string") {
    const feedback = body.feedback === "up" || body.feedback === "down" ? body.feedback : null;
    const correccion = typeof body.correccion === "string" ? body.correccion.slice(0, 4000) : undefined;
    const r = await prisma.juridicoMensaje.updateMany({
      where: { id: body.mensajeId, conversacionId: id, rol: "assistant" },
      data: { feedback, ...(correccion !== undefined ? { correccion } : {}) },
    });
    if (r.count === 0) return NextResponse.json({ error: "Mensaje no encontrado" }, { status: 404 });
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Nada que cambiar" }, { status: 400 });
}

// DELETE /api/juridico/conversaciones/[id] — archiva (no borra: cada corrección es una fila del eval).
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let usuario: { id: string };
  try {
    usuario = await requireUser(req);
  } catch (e) {
    return NextResponse.json({ error: e instanceof AuthzError ? e.message : "Unauthorized" }, { status: e instanceof AuthzError ? e.status : 401 });
  }
  if (!(await isOperador(usuario.id))) return NextResponse.json({ error: "Sólo el operador" }, { status: 403 });
  const { id } = await params;
  const conv = await cargar(id, usuario.id);
  if (!conv) return NextResponse.json({ error: "Conversación no encontrada" }, { status: 404 });
  await prisma.juridicoConversacion.update({ where: { id }, data: { archivedAt: new Date() } });
  return NextResponse.json({ ok: true });
}
