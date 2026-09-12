/**
 * POST /api/hospital/pacientes/[id]/documentos/[docId]/archivo — guarda el
 *      archivo de un documento del PACIENTE: la identificación y la constancia
 *      fiscal que el alta adjunta, una póliza… Multipart con el campo
 *      `archivo`, o JSON { base64, mime, nombre? } para el cliente del
 *      satélite. PDF/JPG/PNG/WebP, ≤ 10 MB. Un PENDIENTE pasa a RECIBIDO.
 * GET  …/archivo — descarga (siempre attachment) y registra el acceso como
 *      EXPORTACION (NOM-024 / LFPDPPP).
 *
 * Es la misma operación que /episodios/[id]/documentos/[docId]/archivo, con
 * otra regla de pertenencia: aquí el documento tiene que ser del paciente de
 * la URL, tenga o no episodio — desde la ficha se baja también un
 * consentimiento de una atención pasada.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error } from "@/lib/hospital/http";
import { registrarAcceso } from "@/lib/hospital/accesos";
import { datosDeArchivo, errorDeTamano, leerArchivo, respuestaDescarga } from "@/lib/hospital/documento-archivo";

type Ctx = { params: Promise<{ id: string; docId: string }> };

async function documentoDe(pacienteId: string, docId: string) {
  const doc = await prisma.hospDocumento.findUnique({
    where: { id: docId },
    select: { id: true, episodioId: true, pacienteId: true, companyId: true, tipo: true, nombre: true, estado: true, mime: true, bytes: true, paciente: { select: { expedienteNumero: true } } },
  });
  if (!doc || doc.pacienteId !== pacienteId) throw new AuthzError(404, "Documento no encontrado");
  return doc;
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
    detalle: { expediente: doc.paciente.expedienteNumero, episodioId: doc.episodioId, tipo: doc.tipo, nombre: doc.nombre, mime: archivo.mime, bytes: archivo.buffer.length, archivoNombre: archivo.nombre },
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
    pacienteId: doc.pacienteId,
    detalle: `Descarga de «${doc.nombre}» (${doc.tipo})${doc.paciente.expedienteNumero ? ` · exp. ${doc.paciente.expedienteNumero}` : ""}`,
    user,
    req,
  });

  return respuestaDescarga(conArchivo.archivo, doc.mime, doc.nombre);
});
