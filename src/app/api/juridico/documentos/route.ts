import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AuthzError, puedeUsarJuridico, requireUser } from "@/lib/authz";
import {
  MAX_BYTES_DOCUMENTO,
  MAX_CARACTERES_POR_CONVERSACION,
  MAX_DOCUMENTOS_POR_CONVERSACION,
  UMBRAL_RESUMEN,
  extraerTextoDocumento,
  indexarDocumento,
  limpiarTexto,
  resumirDocumento,
  type Resumenes,
} from "@/lib/juridico/documentos";
import { reportError } from "@/lib/observability";
import { MAX_BYTES_IMAGEN, MAX_BYTES_PDF_VISION, MAX_IMAGENES_POR_DOCUMENTO, MAX_PAGINAS_PDF_VISION, esHeic, tipoImagen, transcribirConVision, type MediaImagen } from "@/lib/juridico/vision";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/juridico/documentos — sube documentos a una conversación del
// copiloto jurídico. multipart/form-data con uno o varios `file` y, opcional,
// `conversacionId`; sin conversación se crea una titulada como el archivo.
//
// - PDF con texto, DOCX, TXT: se extrae el texto aquí (pdf-parse / mammoth).
// - Fotos (JPEG/PNG/WebP/GIF) y PDF escaneados: se TRANSCRIBEN con visión
//   (vision.ts). Varias fotos en la misma subida son UN documento (páginas en
//   el orden en que llegan).
// Se indexa por secciones y se guarda el texto — NO el archivo. Un contrato es
// confidencial: vive en la conversación de su dueño y se borra con DELETE.
// Respuesta: { conversacionId, nueva, documentos: [{ id, nombre, mime, bytes, paginas, caracteres, secciones, transcrito, resumido }] }
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const anthropic = new Anthropic();

interface Preparado {
  nombre: string;
  mime: string;
  bytes: number;
  hash: string;
  paginas: number | null;
  texto: string;
  transcrito: boolean;
}

class ErrorSubida extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

async function prepararArchivo(file: File, buffer: Uint8Array, cost: { userId: string }): Promise<Preparado> {
  const hash = createHash("sha256").update(buffer).digest("hex");
  if (esHeic(buffer)) throw new ErrorSubida(415, `${file.name}: es una foto HEIC (iPhone). Cámbiala a JPEG (Ajustes › Cámara › Formatos › Más compatible) o compártela como PDF.`);
  let extraido: Awaited<ReturnType<typeof extraerTextoDocumento>>;
  try {
    extraido = await extraerTextoDocumento(buffer, file.name, file.type || null);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "No se pudo leer el archivo.";
    throw new ErrorSubida(415, /Invalid PDF|password/i.test(msg) ? `${file.name}: el PDF está dañado o protegido con contraseña.` : `${file.name}: ${msg}`);
  }
  let texto = limpiarTexto(extraido.texto);
  let transcrito = false;
  if (texto.length < 200 && extraido.formato === "pdf") {
    // Escaneado: sin capa de texto. Lo lee el modelo.
    if (buffer.byteLength > MAX_BYTES_PDF_VISION) throw new ErrorSubida(413, `${file.name}: es un PDF escaneado de más de 32 MB; divídelo.`);
    if ((extraido.paginas ?? 0) > MAX_PAGINAS_PDF_VISION) throw new ErrorSubida(413, `${file.name}: es un PDF escaneado de ${extraido.paginas} páginas; el máximo para transcribir es ${MAX_PAGINAS_PDF_VISION}. Divídelo.`);
    const t = await transcribirConVision(anthropic, [{ tipo: "pdf", data: buffer }], { etiqueta: file.name, cost: { companyId: null, userId: cost.userId } });
    texto = limpiarTexto(t.texto);
    transcrito = true;
  }
  if (texto.length < 200) throw new ErrorSubida(422, `${file.name}: no trae texto legible.`);
  return { nombre: file.name.slice(0, 200), mime: file.type || extraido.formato, bytes: file.size, hash, paginas: extraido.paginas, texto, transcrito };
}

async function prepararFotos(fotos: { file: File; buffer: Uint8Array; media: MediaImagen }[], cost: { userId: string }): Promise<Preparado> {
  if (fotos.length > MAX_IMAGENES_POR_DOCUMENTO) throw new ErrorSubida(413, `Son ${fotos.length} fotos; el máximo por documento es ${MAX_IMAGENES_POR_DOCUMENTO}. Súbelas en dos tandas.`);
  for (const f of fotos) {
    if (f.buffer.byteLength > MAX_BYTES_IMAGEN) throw new ErrorSubida(413, `${f.file.name}: la foto pesa más de 5 MB. Redúcela (una captura o una foto en calidad media basta).`);
  }
  const t = await transcribirConVision(
    anthropic,
    fotos.map((f) => ({ tipo: "imagen" as const, media: f.media, data: f.buffer })),
    { etiqueta: fotos[0].file.name, cost: { companyId: null, userId: cost.userId } }
  );
  const texto = limpiarTexto(t.texto);
  if (texto.length < 100) throw new ErrorSubida(422, "En las fotos no se distingue texto legible. Prueba con más luz, la hoja completa y de frente.");
  const hash = createHash("sha256");
  for (const f of fotos) hash.update(f.buffer);
  const primero = fotos[0].file.name.replace(/\.[a-z0-9]{2,5}$/i, "");
  return {
    nombre: (fotos.length === 1 ? fotos[0].file.name : `${primero} (+${fotos.length - 1} fotos)`).slice(0, 200),
    mime: fotos[0].media,
    bytes: fotos.reduce((a, f) => a + f.file.size, 0),
    hash: hash.digest("hex"),
    paginas: fotos.length,
    texto,
    transcrito: true,
  };
}

export async function POST(req: Request) {
  let usuario: { id: string };
  try {
    usuario = await requireUser(req);
  } catch (e) {
    return NextResponse.json({ error: e instanceof AuthzError ? e.message : "Unauthorized" }, { status: e instanceof AuthzError ? e.status : 401 });
  }
  const userId = usuario.id;
  if (!(await puedeUsarJuridico(userId))) return NextResponse.json({ error: "Tu cuenta no tiene acceso al copiloto jurídico" }, { status: 403 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Manda multipart/form-data con el campo `file`." }, { status: 400 });
  }
  const archivos = form.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
  if (archivos.length === 0) return NextResponse.json({ error: "Falta el archivo (`file`)." }, { status: 400 });
  for (const f of archivos) {
    if (f.size > MAX_BYTES_DOCUMENTO) return NextResponse.json({ error: `${f.name} pesa más de ${MAX_BYTES_DOCUMENTO / 1024 / 1024} MB.` }, { status: 413 });
  }

  const convIdIn = form.get("conversacionId");
  let convId = typeof convIdIn === "string" && convIdIn.trim() ? convIdIn.trim() : null;
  let caracteresPrevios = 0;
  let docsPrevios = 0;
  if (convId) {
    const conv = await prisma.juridicoConversacion.findUnique({ where: { id: convId }, select: { userId: true, archivedAt: true } });
    if (!conv || conv.userId !== userId || conv.archivedAt) return NextResponse.json({ error: "Conversación no encontrada" }, { status: 404 });
    const previos = await prisma.juridicoDocumento.aggregate({ where: { conversacionId: convId }, _count: { id: true }, _sum: { caracteres: true } });
    docsPrevios = previos._count.id;
    caracteresPrevios = previos._sum.caracteres ?? 0;
  }

  // Fotos juntas = un documento; lo demás, un documento por archivo.
  const fotos: { file: File; buffer: Uint8Array; media: MediaImagen }[] = [];
  const otros: { file: File; buffer: Uint8Array }[] = [];
  for (const file of archivos) {
    const buffer = new Uint8Array(await file.arrayBuffer());
    const media = tipoImagen(buffer);
    if (media) fotos.push({ file, buffer, media });
    else otros.push({ file, buffer });
  }
  const nuevos = otros.length + (fotos.length > 0 ? 1 : 0);
  if (docsPrevios + nuevos > MAX_DOCUMENTOS_POR_CONVERSACION) {
    return NextResponse.json({ error: `Una conversación admite hasta ${MAX_DOCUMENTOS_POR_CONVERSACION} documentos (ya tiene ${docsPrevios}); abre otra para más.` }, { status: 409 });
  }

  let preparados: Preparado[];
  try {
    preparados = await Promise.all([...(fotos.length > 0 ? [prepararFotos(fotos, { userId })] : []), ...otros.map((o) => prepararArchivo(o.file, o.buffer, { userId }))]);
  } catch (e) {
    if (e instanceof ErrorSubida) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("[juridico/documentos]", e);
    return NextResponse.json({ error: "No se pudo leer el archivo; si es una foto o un escaneo, inténtalo de nuevo en un momento." }, { status: 500 });
  }
  const caracteresNuevos = preparados.reduce((a, p) => a + p.texto.length, 0);
  if (caracteresPrevios + caracteresNuevos > MAX_CARACTERES_POR_CONVERSACION) {
    return NextResponse.json({ error: "Entre todos los documentos de la conversación se pasa el límite de texto; abre otra conversación para este archivo." }, { status: 413 });
  }

  let nueva = false;
  if (!convId) {
    const titulo = preparados[0].nombre.replace(/\.[a-z0-9]{2,5}$/i, "").trim().slice(0, 80) || "Documento";
    const created = await prisma.juridicoConversacion.create({ data: { userId, titulo }, select: { id: true } });
    convId = created.id;
    nueva = true;
  }
  const documentos = [];
  for (const p of preparados) {
    const secciones = indexarDocumento(p.texto);
    // Un documento largo (un expediente, una sentencia de 80 páginas) no cabe
    // en el prompt: se resume por secciones al subirlo, en paralelo, para que
    // el agente sepa dónde está cada cosa antes de leer. Si el resumen falla,
    // el documento entra igual (el índice y las herramientas bastan).
    let resumenes: Resumenes | null = null;
    if (p.texto.length > UMBRAL_RESUMEN) {
      try {
        resumenes = await resumirDocumento(anthropic, { id: "", nombre: p.nombre, texto: p.texto, secciones }, { cost: { companyId: null, userId } });
      } catch (e) {
        reportError(e, { ruta: "juridico/documentos", paso: "resumir", nombre: p.nombre, caracteres: p.texto.length });
      }
    }
    const doc = await prisma.juridicoDocumento.create({
      data: {
        conversacionId: convId,
        userId,
        nombre: p.nombre,
        mime: p.mime,
        bytes: p.bytes,
        hash: p.hash,
        paginas: p.paginas,
        caracteres: p.texto.length,
        texto: p.texto,
        secciones: secciones as unknown as Prisma.InputJsonValue,
        resumenes: resumenes ? (resumenes as unknown as Prisma.InputJsonValue) : undefined,
      },
      select: { id: true, nombre: true, mime: true, bytes: true, paginas: true, caracteres: true, createdAt: true },
    });
    documentos.push({ ...doc, secciones: secciones.length, transcrito: p.transcrito, resumido: !!resumenes });
  }
  await prisma.juridicoConversacion.update({ where: { id: convId }, data: { updatedAt: new Date() } });
  return NextResponse.json({ conversacionId: convId, nueva, documentos, documento: documentos[0] }, { status: 201 });
}
