/**
 * PATCH /api/hospital/episodios/[id]/documentos/[docId]
 *   { estado?, firmadoAt?, nombre?, requerido?, contenido?, firmadoPor?, firmadoParentesco?,
 *     testigo1?, testigo2?, medicoId?, medicoNombre?, medicoCedula? }
 *
 * FIRMADO fija `firmadoAt` (ahora, si no viene) y exige el contenido mínimo y
 * las firmas del tipo (lib/hospital/documentos.ts). Volver a PENDIENTE borra
 * la fecha. Un documento ya FIRMADO no cambia de contenido ni de firmantes
 * (409): se registra otro documento.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { aFecha, bitacora, error, errorZod, fechaSchema } from "@/lib/hospital/http";
import { CAMPOS_CONGELADOS_AL_FIRMAR, errorContenido, errorFirma } from "@/lib/hospital/documentos";

const schema = z.object({
  estado: z.enum(["PENDIENTE", "RECIBIDO", "FIRMADO"]).optional(),
  firmadoAt: fechaSchema.nullable().optional(),
  nombre: z.string().min(1).max(200).optional(),
  requerido: z.boolean().optional(),
  contenido: z.record(z.string(), z.unknown()).nullable().optional(),
  firmadoPor: z.string().max(160).nullable().optional(),
  firmadoParentesco: z.string().max(60).nullable().optional(),
  testigo1: z.string().max(160).nullable().optional(),
  testigo2: z.string().max(160).nullable().optional(),
  medicoId: z.string().nullable().optional(),
  medicoNombre: z.string().max(160).nullable().optional(),
  medicoCedula: z.string().max(20).nullable().optional(),
});

export const PATCH = withHospital(async (req: Request, ctx: { params: Promise<{ id: string; docId: string }> }) => {
  const { id, docId } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const doc = await prisma.hospDocumento.findUnique({
    where: { id: docId },
    omit: { archivo: true },
    include: { episodio: { select: { id: true, companyId: true, folio: true } } },
  });
  if (!doc || doc.episodioId !== id) throw new AuthzError(404, "Documento no encontrado");

  const { user } = await requireWriter(doc.episodio.companyId, req);
  await requireModule(doc.episodio.companyId, "HOSPITAL", req);

  const tocaFirma = CAMPOS_CONGELADOS_AL_FIRMAR.some((c) => c in d) || "medicoId" in d;
  if (doc.estado === "FIRMADO" && tocaFirma) {
    return error(`El documento «${doc.nombre}» ya está firmado: su contenido y sus firmantes no se modifican; registra otro documento`, 409);
  }

  let medicoNombre = d.medicoNombre === undefined ? doc.medicoNombre : d.medicoNombre?.trim() || null;
  let medicoCedula = d.medicoCedula === undefined ? doc.medicoCedula : d.medicoCedula?.trim() || null;
  if (d.medicoId) {
    const m = await prisma.hospMedico.findUnique({ where: { id: d.medicoId }, select: { companyId: true, nombre: true, cedula: true } });
    if (!m || m.companyId !== doc.episodio.companyId) return error("medicoId inválido");
    medicoNombre = d.medicoNombre?.trim() || m.nombre;
    medicoCedula = d.medicoCedula?.trim() || m.cedula?.trim() || null;
  }

  const estado = d.estado ?? doc.estado;
  const resultante = {
    tipo: doc.tipo,
    contenido: d.contenido === undefined ? doc.contenido : d.contenido,
    firmadoPor: d.firmadoPor === undefined ? doc.firmadoPor : d.firmadoPor?.trim() || null,
    firmadoParentesco: d.firmadoParentesco === undefined ? doc.firmadoParentesco : d.firmadoParentesco?.trim() || null,
    testigo1: d.testigo1 === undefined ? doc.testigo1 : d.testigo1?.trim() || null,
    testigo2: d.testigo2 === undefined ? doc.testigo2 : d.testigo2?.trim() || null,
    medicoNombre,
    medicoCedula,
  };
  const motivo = estado === "FIRMADO" ? errorFirma(resultante) : errorContenido(doc.tipo, resultante.contenido, false);
  if (motivo) return error(motivo);

  const firmadoAt =
    estado === "FIRMADO" ? (aFecha(d.firmadoAt) ?? doc.firmadoAt ?? new Date()) : estado === "PENDIENTE" ? null : (aFecha(d.firmadoAt) ?? doc.firmadoAt);

  const actualizado = await prisma.hospDocumento.update({
    where: { id: docId },
    data: {
      estado,
      firmadoAt,
      ...(d.nombre ? { nombre: d.nombre.trim() } : {}),
      ...(d.requerido !== undefined ? { requerido: d.requerido } : {}),
      ...(d.contenido !== undefined ? { contenido: d.contenido === null ? undefined : (d.contenido as object) } : {}),
      firmadoPor: resultante.firmadoPor,
      firmadoParentesco: resultante.firmadoParentesco,
      testigo1: resultante.testigo1,
      testigo2: resultante.testigo2,
      medicoNombre,
      medicoCedula,
    },
    omit: { archivo: true },
  });

  if (doc.estado !== estado || tocaFirma) {
    bitacora(user, req, {
      companyId: doc.episodio.companyId,
      accion: doc.estado !== estado ? "hospital.documento.estado" : "hospital.documento.editar",
      entidad: "HospDocumento",
      entidadId: docId,
      detalle: { folio: doc.episodio.folio, tipo: doc.tipo, de: doc.estado, a: estado, campos: Object.keys(d) },
    });
  }

  return NextResponse.json(actualizado);
});
