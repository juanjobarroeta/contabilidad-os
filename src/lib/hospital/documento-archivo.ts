// ─────────────────────────────────────────────────────────────────────────────
// EL ARCHIVO DE UN DOCUMENTO DEL EXPEDIENTE: subir y descargar.
//
// Un HospDocumento nace como registro (PENDIENTE) y recibe su archivo después:
// el PDF firmado del consentimiento, la foto de la identificación, la
// constancia fiscal. Dos rutas lo sirven —por episodio y por paciente— porque
// el documento puede ser de la atención o de la persona; con los bytes hacen
// exactamente lo mismo. Lo común vive aquí; cada ruta sólo decide si el
// documento le pertenece.
//
// Visto en producción: el alta del paciente subía la identificación a
// /pacientes/[id]/documentos/[docId]/archivo y el hub contestaba 404, porque
// sólo existía la ruta por episodio. Nadie lo había pisado antes: hasta ese
// día el teléfono no dejaba elegir el archivo.
//
// Los bytes viven en la BD (bytea), mismo patrón que el expediente del
// empleado (EmployeeDocumento) y los acuses de declaración.
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";

export const MAX_BYTES = 10 * 1024 * 1024;
export const MIMES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
export const EXTENSION: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export type ArchivoLeido = { buffer: Buffer; mime: string; nombre: string | null };
export type ArchivoRechazado = { error: string; status: number };

/**
 * Lee el archivo del body: multipart con el campo `archivo`, o JSON
 * { base64, mime, nombre? } para el cliente del satélite (apiFetch habla JSON).
 * Sólo PDF/JPG/PNG/WebP.
 */
export async function leerArchivo(req: Request): Promise<ArchivoLeido | ArchivoRechazado> {
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

/** Vacío → 400; más de 10 MB → 413; si cabe, null. */
export function errorDeTamano(buffer: Buffer): ArchivoRechazado | null {
  if (buffer.length === 0) return { error: "Archivo vacío", status: 400 };
  if (buffer.length > MAX_BYTES) return { error: `El archivo pesa ${(buffer.length / 1048576).toFixed(1)} MB; el máximo es 10 MB`, status: 413 };
  return null;
}

/** Los datos que se escriben al documento: un PENDIENTE pasa a RECIBIDO; FIRMADO se sigue marcando con PATCH o con las firmas. */
export function datosDeArchivo(archivo: ArchivoLeido, estadoActual: string, userId: string): Prisma.HospDocumentoUncheckedUpdateInput {
  return {
    archivo: new Uint8Array(archivo.buffer),
    mime: archivo.mime,
    bytes: archivo.buffer.length,
    subidoPorUserId: userId,
    ...(estadoActual === "PENDIENTE" ? { estado: "RECIBIDO" } : {}),
  };
}

/** Nombre del archivo descargado: saneado para no romper el encabezado, con la extensión del MIME si no la trae. */
export function nombreDeDescarga(nombre: string, mime: string): string {
  const base = nombre.replace(/[^\w. ()-]/g, "_").trim() || "documento";
  const ext = EXTENSION[mime] ?? "bin";
  return base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
}

/**
 * SIEMPRE attachment: el expediente se descarga, no se ejecuta en el origen
 * del hub.
 */
export function respuestaDescarga(archivo: Uint8Array, mime: string, nombre: string): NextResponse {
  return new NextResponse(new Uint8Array(archivo), {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(archivo.length),
      "Content-Disposition": `attachment; filename="${nombreDeDescarga(nombre, mime)}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
