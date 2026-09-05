/**
 * POST /api/hospital/episodios/[id]/documentos — registra un documento del
 * expediente. Nace PENDIENTE; el archivo se sube aparte
 * (POST …/documentos/[docId]/archivo).
 *
 * P1 (NOM-004 §10): `contenido` es el JSON con el contenido mínimo del tipo
 * (consentimiento: procedimiento, riesgos, beneficios, alternativas; registro
 * anestésico; hoja de egreso…) y las firmas van en columnas: firmadoPor y
 * parentesco, dos testigos, médico que informa con cédula (`medicoId` los
 * llena desde HospMedico). Se pueden dejar para después mientras está
 * PENDIENTE; para nacer o pasar a FIRMADO tienen que estar completos.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { aFecha, bitacora, error, errorZod, fechaSchema } from "@/lib/hospital/http";
import { TIPOS_DOCUMENTO, errorContenido, errorFirma } from "@/lib/hospital/documentos";

const schema = z.object({
  tipo: z.enum(TIPOS_DOCUMENTO),
  nombre: z.string().min(1).max(200),
  requerido: z.boolean().optional(),
  estado: z.enum(["PENDIENTE", "RECIBIDO", "FIRMADO"]).optional(),
  firmadoAt: fechaSchema.nullable().optional(),
  contenido: z.record(z.string(), z.unknown()).nullable().optional(),
  firmadoPor: z.string().max(160).nullable().optional(),
  firmadoParentesco: z.string().max(60).nullable().optional(),
  testigo1: z.string().max(160).nullable().optional(),
  testigo2: z.string().max(160).nullable().optional(),
  medicoId: z.string().nullable().optional(),
  medicoNombre: z.string().max(160).nullable().optional(),
  medicoCedula: z.string().max(20).nullable().optional(),
});

export const POST = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const ep = await prisma.hospEpisodio.findUnique({ where: { id }, select: { id: true, companyId: true, estado: true, folio: true } });
  if (!ep) throw new AuthzError(404, "Episodio no encontrado");

  const { user } = await requireWriter(ep.companyId, req);
  await requireModule(ep.companyId, "HOSPITAL", req);
  if (ep.estado === "CANCELADO") return error(`El episodio ${ep.folio} está cancelado`, 409);

  let medicoNombre = d.medicoNombre?.trim() || null;
  let medicoCedula = d.medicoCedula?.trim() || null;
  if (d.medicoId) {
    const m = await prisma.hospMedico.findUnique({ where: { id: d.medicoId }, select: { companyId: true, nombre: true, cedula: true } });
    if (!m || m.companyId !== ep.companyId) return error("medicoId inválido");
    medicoNombre ??= m.nombre;
    medicoCedula ??= m.cedula?.trim() || null;
  }

  const estado = d.estado ?? "PENDIENTE";
  const firma = {
    tipo: d.tipo,
    contenido: d.contenido ?? null,
    firmadoPor: d.firmadoPor?.trim() || null,
    firmadoParentesco: d.firmadoParentesco?.trim() || null,
    testigo1: d.testigo1?.trim() || null,
    testigo2: d.testigo2?.trim() || null,
    medicoNombre,
    medicoCedula,
  };
  const motivo = estado === "FIRMADO" ? errorFirma(firma) : errorContenido(d.tipo, firma.contenido, false);
  if (motivo) return error(motivo);

  const doc = await prisma.hospDocumento.create({
    data: {
      companyId: ep.companyId,
      episodioId: ep.id,
      tipo: d.tipo,
      nombre: d.nombre.trim(),
      requerido: d.requerido ?? true,
      estado,
      firmadoAt: estado === "FIRMADO" ? (aFecha(d.firmadoAt) ?? new Date()) : null,
      subidoPorUserId: user.id,
      contenido: firma.contenido === null ? undefined : (firma.contenido as object),
      firmadoPor: firma.firmadoPor,
      firmadoParentesco: firma.firmadoParentesco,
      testigo1: firma.testigo1,
      testigo2: firma.testigo2,
      medicoNombre,
      medicoCedula,
    },
    omit: { archivo: true },
  });

  bitacora(user, req, {
    companyId: ep.companyId,
    accion: "hospital.documento.crear",
    entidad: "HospDocumento",
    entidadId: doc.id,
    detalle: { folio: ep.folio, tipo: d.tipo, nombre: doc.nombre, estado: doc.estado, conContenido: !!firma.contenido },
  });

  return NextResponse.json(doc, { status: 201 });
});
