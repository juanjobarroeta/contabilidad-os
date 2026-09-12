import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AuthzError, isOperador, requireUser } from "@/lib/authz";
import {
  MAX_BYTES_DOCUMENTO,
  MAX_CARACTERES_POR_CONVERSACION,
  MAX_DOCUMENTOS_POR_CONVERSACION,
  extraerTextoDocumento,
  indexarDocumento,
  limpiarTexto,
} from "@/lib/juridico/documentos";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/juridico/documentos — sube un documento (PDF, DOCX, TXT) a una
// conversación del copiloto jurídico. multipart/form-data: `file` y, opcional,
// `conversacionId`; sin conversación se crea una titulada como el archivo.
//
// Se extrae el texto aquí mismo (pdf-parse / mammoth), se indexa por secciones
// y se guarda el texto — NO el archivo. Un contrato es confidencial: vive en
// la conversación de su dueño y se borra de verdad con DELETE.
// Respuesta: { conversacionId, nueva, documento: { id, nombre, bytes, paginas, caracteres, secciones } }
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  let usuario: { id: string };
  try {
    usuario = await requireUser(req);
  } catch (e) {
    return NextResponse.json({ error: e instanceof AuthzError ? e.message : "Unauthorized" }, { status: e instanceof AuthzError ? e.status : 401 });
  }
  const userId = usuario.id;
  if (!(await isOperador(userId))) return NextResponse.json({ error: "Sólo el operador puede usar el copiloto jurídico por ahora" }, { status: 403 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Manda multipart/form-data con el campo `file`." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Falta el archivo (`file`)." }, { status: 400 });
  if (file.size === 0) return NextResponse.json({ error: "El archivo está vacío." }, { status: 400 });
  if (file.size > MAX_BYTES_DOCUMENTO) return NextResponse.json({ error: `El archivo pesa más de ${MAX_BYTES_DOCUMENTO / 1024 / 1024} MB.` }, { status: 413 });

  const convIdIn = form.get("conversacionId");
  let convId = typeof convIdIn === "string" && convIdIn.trim() ? convIdIn.trim() : null;
  let caracteresPrevios = 0;
  if (convId) {
    const conv = await prisma.juridicoConversacion.findUnique({ where: { id: convId }, select: { userId: true, archivedAt: true } });
    if (!conv || conv.userId !== userId || conv.archivedAt) return NextResponse.json({ error: "Conversación no encontrada" }, { status: 404 });
    const previos = await prisma.juridicoDocumento.aggregate({ where: { conversacionId: convId }, _count: { id: true }, _sum: { caracteres: true } });
    if (previos._count.id >= MAX_DOCUMENTOS_POR_CONVERSACION) {
      return NextResponse.json({ error: `Una conversación admite hasta ${MAX_DOCUMENTOS_POR_CONVERSACION} documentos; abre otra para más.` }, { status: 409 });
    }
    caracteresPrevios = previos._sum.caracteres ?? 0;
  }

  const buffer = new Uint8Array(await file.arrayBuffer());
  let extraido: Awaited<ReturnType<typeof extraerTextoDocumento>>;
  try {
    extraido = await extraerTextoDocumento(buffer, file.name, file.type || null);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "No se pudo leer el archivo.";
    return NextResponse.json({ error: /Invalid PDF|password/i.test(msg) ? "El PDF está dañado o protegido con contraseña." : msg }, { status: 415 });
  }
  const texto = limpiarTexto(extraido.texto);
  if (texto.length < 200) {
    return NextResponse.json({ error: "El archivo no trae texto legible (¿es un escaneo? Por ahora no se hace OCR). Súbelo como PDF con texto o DOCX." }, { status: 422 });
  }
  if (caracteresPrevios + texto.length > MAX_CARACTERES_POR_CONVERSACION) {
    return NextResponse.json({ error: "Entre todos los documentos de la conversación se pasa el límite de texto; abre otra conversación para este archivo." }, { status: 413 });
  }
  const secciones = indexarDocumento(texto);

  let nueva = false;
  if (!convId) {
    const titulo = file.name.replace(/\.[a-z0-9]{2,5}$/i, "").trim().slice(0, 80) || "Documento";
    const created = await prisma.juridicoConversacion.create({ data: { userId, titulo }, select: { id: true } });
    convId = created.id;
    nueva = true;
  }
  const doc = await prisma.juridicoDocumento.create({
    data: {
      conversacionId: convId,
      userId,
      nombre: file.name.slice(0, 200),
      mime: file.type || extraido.formato,
      bytes: file.size,
      hash: createHash("sha256").update(buffer).digest("hex"),
      paginas: extraido.paginas,
      caracteres: texto.length,
      texto,
      secciones: secciones as unknown as Prisma.InputJsonValue,
    },
    select: { id: true, nombre: true, bytes: true, paginas: true, caracteres: true, createdAt: true },
  });
  await prisma.juridicoConversacion.update({ where: { id: convId }, data: { updatedAt: new Date() } });
  return NextResponse.json({ conversacionId: convId, nueva, documento: { ...doc, secciones: secciones.length } }, { status: 201 });
}
