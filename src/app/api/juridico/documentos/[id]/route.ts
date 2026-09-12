import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, puedeUsarJuridico, requireUser } from "@/lib/authz";
import type { Seccion } from "@/lib/juridico/documentos";
import { MIME_BORRADOR } from "@/lib/juridico/redaccion";

async function autorizar(req: Request) {
  const usuario = await requireUser(req);
  if (!(await puedeUsarJuridico(usuario.id))) throw new AuthzError(403, "Tu cuenta no tiene acceso al copiloto jurídico");
  return usuario.id;
}

// GET /api/juridico/documentos/[id] — metadatos e índice de secciones; el texto sólo si es un borrador redactado.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = await autorizar(req);
  } catch (e) {
    return NextResponse.json({ error: e instanceof AuthzError ? e.message : "Unauthorized" }, { status: e instanceof AuthzError ? e.status : 401 });
  }
  const { id } = await params;
  const doc = await prisma.juridicoDocumento.findUnique({
    where: { id },
    select: { id: true, userId: true, conversacionId: true, nombre: true, mime: true, bytes: true, paginas: true, caracteres: true, secciones: true, texto: true, createdAt: true },
  });
  if (!doc || doc.userId !== userId) return NextResponse.json({ error: "Documento no encontrado" }, { status: 404 });
  const secciones = ((doc.secciones as unknown as Seccion[] | null) ?? []).map((s) => ({ n: s.n, titulo: s.titulo, caracteres: s.hasta - s.desde }));
  // El texto sólo de los borradores redactados (para la vista previa); lo subido es confidencial y ya lo tiene el usuario.
  const { texto, userId: _u, ...meta } = doc;
  return NextResponse.json({ ...meta, secciones, ...(doc.mime === MIME_BORRADOR ? { texto } : {}) });
}

// DELETE /api/juridico/documentos/[id] — borra el documento y su texto (no se archiva: es confidencial).
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = await autorizar(req);
  } catch (e) {
    return NextResponse.json({ error: e instanceof AuthzError ? e.message : "Unauthorized" }, { status: e instanceof AuthzError ? e.status : 401 });
  }
  const { id } = await params;
  const r = await prisma.juridicoDocumento.deleteMany({ where: { id, userId } });
  if (r.count === 0) return NextResponse.json({ error: "Documento no encontrado" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
