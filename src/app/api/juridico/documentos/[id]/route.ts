import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, isOperador, requireUser } from "@/lib/authz";
import type { Seccion } from "@/lib/juridico/documentos";

async function autorizar(req: Request) {
  const usuario = await requireUser(req);
  if (!(await isOperador(usuario.id))) throw new AuthzError(403, "Sólo el operador");
  return usuario.id;
}

// GET /api/juridico/documentos/[id] — metadatos e índice de secciones (sin el texto).
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
    select: { id: true, userId: true, conversacionId: true, nombre: true, bytes: true, paginas: true, caracteres: true, secciones: true, createdAt: true },
  });
  if (!doc || doc.userId !== userId) return NextResponse.json({ error: "Documento no encontrado" }, { status: 404 });
  const secciones = ((doc.secciones as unknown as Seccion[] | null) ?? []).map((s) => ({ n: s.n, titulo: s.titulo, caracteres: s.hasta - s.desde }));
  return NextResponse.json({ ...doc, userId: undefined, secciones });
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
