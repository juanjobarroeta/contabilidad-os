/**
 * POST /api/hospital/episodios/[id]/documentos/[docId]/archivo — guarda el
 *      archivo del documento (el PDF firmado del consentimiento, la foto de
 *      la identificación…): multipart con el campo `archivo`, o JSON
 *      { base64, mime, nombre? } para el cliente del satélite (apiFetch habla
 *      JSON). PDF/JPG/PNG/WebP, ≤ 10 MB. Un documento PENDIENTE pasa a
 *      RECIBIDO; el estado FIRMADO se sigue marcando con PATCH (o con las
 *      firmas electrónicas del paquete de admisión).
 * GET  …/archivo — descarga (siempre attachment) y registra el acceso como
 *      EXPORTACION (NOM-024 / LFPDPPP).
 *
 * P2: también sirve para los documentos del PACIENTE (episodioId null, p. ej.
 * la identificación del paquete de admisión) cuando el paciente es el del
 * episodio de la URL.
 *
 * Lo que se hace con los bytes (leer, validar, guardar, servir) vive en
 * lib/hospital/documento-archivo y lo comparte con la ruta por paciente.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error } from "@/lib/hospital/http";
import { registrarAcceso } from "@/lib/hospital/accesos";
import { datosDeArchivo, errorDeTamano, leerArchivo, respuestaDescarga } from "@/lib/hospital/documento-archivo";

type Ctx = { params: Promise<{ id: string; docId: string }> };

async function documentoDe(id: string, docId: string) {
  const doc = await prisma.hospDocumento.findUnique({
    where: { id: docId },
    select: { id: true, episodioId: true, pacienteId: true, companyId: true, tipo: true, nombre: true, estado: true, mime: true, bytes: true, episodio: { select: { folio: true } } },
  });
  if (!doc) throw new AuthzError(404, "Documento no encontrado");
  if (doc.episodioId !== id) {
    const ep = doc.episodioId === null ? await prisma.hospEpisodio.findUnique({ where: { id }, select: { pacienteId: true, companyId: true, folio: true } }) : null;
    if (!ep || ep.pacienteId !== doc.pacienteId || ep.companyId !== doc.companyId) throw new AuthzError(404, "Documento no encontrado");
    return { ...doc, folio: ep.folio, episodioIdAcceso: id };
  }
  return { ...doc, folio: doc.episodio?.folio ?? null, episodioIdAcceso: doc.episodioId };
}

export const POST = withHospital(async (req: Request, ctx: Ctx) => {
  const { id, docId } = await ctx.params;
  const doc = await documentoDe(id, docId);

  const { user } = await requireWriter(doc.companyId, req);
  await requireModule(doc.companyId, "HOSPITAL", req);

  const archivo = await leerArchivo(req);
  if ("error" in archivo) return error(archivo.error, archivo.status);
  const tamano = errorDeTamano(archivo.buffer);
  if (tamano) return error(tamano.error, tamano.status);

  const actualizado = await prisma.hospDocumento.update({
    where: { id: docId },
    data: datosDeArchivo(archivo, doc.estado, user.id),
    select: { id: true, tipo: true, nombre: true, estado: true, mime: true, bytes: true, firmadoAt: true, pacienteId: true, episodioId: true },
  });

  bitacora(user, req, {
    companyId: doc.companyId,
    accion: "hospital.documento.archivo",
    entidad: "HospDocumento",
    entidadId: doc.id,
    detalle: { folio: doc.folio, tipo: doc.tipo, nombre: doc.nombre, mime: archivo.mime, bytes: archivo.buffer.length, archivoNombre: archivo.nombre },
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

  await registrarAcceso({
    companyId: doc.companyId,
    accion: "EXPORTACION",
    episodioId: doc.episodioIdAcceso,
    pacienteId: doc.pacienteId,
    detalle: `Descarga de «${doc.nombre}» (${doc.tipo})${doc.folio ? ` · ${doc.folio}` : ""}`,
    user,
    req,
  });

  return respuestaDescarga(conArchivo.archivo, doc.mime, doc.nombre);
});
