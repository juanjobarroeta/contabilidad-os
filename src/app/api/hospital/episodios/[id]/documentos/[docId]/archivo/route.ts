/**
 * POST /api/hospital/episodios/[id]/documentos/[docId]/archivo — guarda el
 *      archivo del documento (el PDF firmado del consentimiento, la foto de
 *      la identificación…): multipart con el campo `archivo`, o JSON
 *      { base64, mime, nombre? } para el cliente del satélite (apiFetch habla
 *      JSON). PDF/JPG/PNG/WebP, ≤ 10 MB. Un documento PENDIENTE pasa a
 *      RECIBIDO; el estado FIRMADO se sigue marcando con PATCH.
 * GET  …/archivo — descarga (siempre attachment) y registra el acceso como
 *      EXPORTACION (NOM-024 / LFPDPPP).
 *
 * Los bytes viven en la BD (bytea), mismo patrón que el expediente del
 * empleado (EmployeeDocumento) y los acuses de declaración.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error } from "@/lib/hospital/http";
import { registrarAcceso } from "@/lib/hospital/accesos";

type Ctx = { params: Promise<{ id: string; docId: string }> };

const MAX_BYTES = 10 * 1024 * 1024;
const MIMES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
const EXTENSION: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

async function documentoDe(id: string, docId: string) {
  const doc = await prisma.hospDocumento.findUnique({
    where: { id: docId },
    select: { id: true, episodioId: true, companyId: true, tipo: true, nombre: true, estado: true, mime: true, bytes: true, episodio: { select: { folio: true, pacienteId: true } } },
  });
  if (!doc || doc.episodioId !== id) throw new AuthzError(404, "Documento no encontrado");
  return doc;
}

/** Lee el archivo del body: multipart (`archivo`) o JSON { base64, mime, nombre }. */
async function leerArchivo(req: Request): Promise<{ buffer: Buffer; mime: string; nombre: string | null } | { error: string; status: number }> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    const f = form?.get("archivo");
    if (!f || typeof f === "string") return { error: "Falta el archivo (campo multipart «archivo»)", status: 400 };
    const mime = (f.type || "").toLowerCase();
    if (!MIMES.has(mime)) return { error: "Formato no admitido — PDF, JPG, PNG o WebP", status: 415 };
    return { buffer: Buffer.from(await f.arrayBuffer()), mime, nombre: f.name || null };
  }
  const body = (await req.json().catch(() => null)) as { base64?: unknown; mime?: unknown; nombre?: unknown } | null;
  if (!body || typeof body.base64 !== "string" || !body.base64) return { error: "Manda multipart con «archivo» o JSON { base64, mime, nombre? }", status: 400 };
  const mime = String(body.mime ?? "").toLowerCase();
  if (!MIMES.has(mime)) return { error: "Formato no admitido — PDF, JPG, PNG o WebP", status: 415 };
  return { buffer: Buffer.from(body.base64, "base64"), mime, nombre: typeof body.nombre === "string" ? body.nombre.slice(0, 200) : null };
}

export const POST = withHospital(async (req: Request, ctx: Ctx) => {
  const { id, docId } = await ctx.params;
  const doc = await documentoDe(id, docId);

  const { user } = await requireWriter(doc.companyId, req);
  await requireModule(doc.companyId, "HOSPITAL", req);

  const archivo = await leerArchivo(req);
  if ("error" in archivo) return error(archivo.error, archivo.status);
  if (archivo.buffer.length === 0) return error("Archivo vacío");
  if (archivo.buffer.length > MAX_BYTES) return error(`El archivo pesa ${(archivo.buffer.length / 1048576).toFixed(1)} MB; el máximo es 10 MB`, 413);

  const actualizado = await prisma.hospDocumento.update({
    where: { id: docId },
    data: {
      archivo: new Uint8Array(archivo.buffer),
      mime: archivo.mime,
      bytes: archivo.buffer.length,
      subidoPorUserId: user.id,
      ...(doc.estado === "PENDIENTE" ? { estado: "RECIBIDO" } : {}),
    },
    select: { id: true, tipo: true, nombre: true, estado: true, mime: true, bytes: true, firmadoAt: true },
  });

  bitacora(user, req, {
    companyId: doc.companyId,
    accion: "hospital.documento.archivo",
    entidad: "HospDocumento",
    entidadId: doc.id,
    detalle: { folio: doc.episodio.folio, tipo: doc.tipo, nombre: doc.nombre, mime: archivo.mime, bytes: archivo.buffer.length, archivoNombre: archivo.nombre },
  });

  return NextResponse.json(actualizado, { status: 201 });
});

export const GET = withHospital(async (req: Request, ctx: Ctx) => {
  const { id, docId } = await ctx.params;
  const doc = await documentoDe(id, docId);

  const { user } = await requireMembership(doc.companyId, undefined, req);
  await requireModule(doc.companyId, "HOSPITAL", req);

  const conArchivo = await prisma.hospDocumento.findUnique({ where: { id: docId }, select: { archivo: true } });
  if (!conArchivo?.archivo || !doc.mime) return error("El documento no tiene archivo", 404);

  registrarAcceso({
    companyId: doc.companyId,
    accion: "EXPORTACION",
    episodioId: doc.episodioId,
    pacienteId: doc.episodio.pacienteId,
    detalle: `Descarga de «${doc.nombre}» (${doc.tipo}) · ${doc.episodio.folio}`,
    user,
    req,
  });

  // SIEMPRE attachment: el expediente se descarga, no se ejecuta en el
  // origen del hub. El nombre va saneado para no romper el encabezado.
  const base = doc.nombre.replace(/[^\w. ()-]/g, "_").trim() || "documento";
  const ext = EXTENSION[doc.mime] ?? "bin";
  const nombre = base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
  return new NextResponse(new Uint8Array(conArchivo.archivo), {
    headers: {
      "Content-Type": doc.mime,
      "Content-Length": String(conArchivo.archivo.length),
      "Content-Disposition": `attachment; filename="${nombre}"`,
      "Cache-Control": "private, no-store",
    },
  });
});
