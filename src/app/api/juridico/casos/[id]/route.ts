import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { autorizarJuridico, respuestaDeError } from "@/lib/juridico/api-guardia";
import { cargarAsunto } from "@/lib/juridico/asuntos";
import { asignarResponsable, cambiarEstadoCaso, esEstadoCaso, ligarClienteACaso, moverConversacionACaso } from "@/lib/juridico/casos";
import { listarTareas } from "@/lib/juridico/tareas";

// GET /api/juridico/casos/[id] — la ficha completa: partes, decisiones,
// conversaciones, documentos y pendientes.
// PATCH — estado, responsable, cliente, o mover una conversación aquí.
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = await autorizarJuridico(req);
  } catch (e) {
    return respuestaDeError(e);
  }
  const { id } = await params;
  const caso = await cargarAsunto(id, userId);
  if (!caso) return NextResponse.json({ error: "Caso no encontrado" }, { status: 404 });
  const [meta, conversaciones, documentos, tareas] = await Promise.all([
    prisma.juridicoCaso.findUnique({ where: { id }, select: { estado: true, clienteId: true, responsableUserId: true, cerradoAt: true, createdAt: true, updatedAt: true, clienteRef: { select: { id: true, nombre: true, rfc: true, tipoPersona: true } } } }),
    prisma.juridicoConversacion.findMany({ where: { casoId: id, archivedAt: null }, orderBy: { updatedAt: "desc" }, select: { id: true, titulo: true, updatedAt: true } }),
    prisma.juridicoDocumento.findMany({ where: { casoId: id }, orderBy: { createdAt: "desc" }, select: { id: true, nombre: true, mime: true, paginas: true, caracteres: true, estado: true, createdAt: true } }),
    listarTareas(id),
  ]);
  return NextResponse.json({ ...caso, ...meta, clienteRef: meta?.clienteRef ?? null, conversaciones, documentos, tareas });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = await autorizarJuridico(req);
  } catch (e) {
    return respuestaDeError(e);
  }
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    if (esEstadoCaso(body.estado)) await cambiarEstadoCaso(id, userId, body.estado, { userId });
    if ("responsableUserId" in body) await asignarResponsable(id, userId, typeof body.responsableUserId === "string" ? body.responsableUserId : null, { userId });
    if ("clienteId" in body) await ligarClienteACaso(id, userId, typeof body.clienteId === "string" ? body.clienteId : null, { userId });
    if (typeof body.moverConversacionId === "string") await moverConversacionACaso(body.moverConversacionId, id, userId, { userId });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return respuestaDeError(e);
  }
}
