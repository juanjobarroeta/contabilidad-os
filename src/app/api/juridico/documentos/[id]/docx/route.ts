import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, puedeUsarJuridico, requireUser } from "@/lib/authz";
import { docxDesdeMarkdown, MIME_BORRADOR } from "@/lib/juridico/redaccion";

// GET /api/juridico/documentos/[id]/docx — el documento como Word. Un borrador
// redactado (text/markdown) sale con su formato; un documento subido sale con
// su texto extraído en párrafos (útil para llevarse una transcripción).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    const u = await requireUser(req);
    if (!(await puedeUsarJuridico(u.id))) throw new AuthzError(403, "Tu cuenta no tiene acceso al copiloto jurídico");
    userId = u.id;
  } catch (e) {
    return NextResponse.json({ error: e instanceof AuthzError ? e.message : "Unauthorized" }, { status: e instanceof AuthzError ? e.status : 401 });
  }
  const { id } = await params;
  const doc = await prisma.juridicoDocumento.findUnique({ where: { id }, select: { userId: true, nombre: true, mime: true, texto: true } });
  if (!doc || doc.userId !== userId) return NextResponse.json({ error: "Documento no encontrado" }, { status: 404 });
  const titulo = doc.nombre.replace(/\.[a-z0-9]{2,5}$/i, "");
  const markdown = doc.mime === MIME_BORRADOR ? doc.texto : doc.texto.replace(/\n{2,}/g, "\n\n");
  const buf = await docxDesdeMarkdown(markdown, titulo);
  const nombre = `${titulo}.docx`.replace(/[\\/:*?"<>|]+/g, "-");
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${nombre.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(nombre)}`,
      "Cache-Control": "private, no-store",
    },
  });
}
