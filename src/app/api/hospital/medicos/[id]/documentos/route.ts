/**
 * POST /api/hospital/medicos/[id]/documentos
 *   { tipo, numero?, emitidoPor?, vigenciaHasta?, notas?, base64?, mime?, nombreArchivo? }
 *
 * Agrega un documento al expediente de credencialización (con o sin archivo:
 * a veces sólo se captura el número de cédula). Entra RECIBIDO; lo verifica
 * alguien después (PATCH …/documentos/[docId]). Un documento nuevo del mismo
 * tipo no borra el anterior: el resumen toma el verificado más vigente.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { aFecha, bitacora, error, errorZod, fechaSchema } from "@/lib/hospital/http";
import { TIPOS_DOCUMENTO, selectDocumento } from "@/lib/hospital/medico-credencial";


export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_BYTES = 8 * 1024 * 1024;
const MIMES = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"];

const schema = z.object({
  tipo: z.enum(TIPOS_DOCUMENTO as [string, ...string[]]),
  numero: z.string().trim().max(60).nullable().optional(),
  emitidoPor: z.string().trim().max(200).nullable().optional(),
  vigenciaHasta: fechaSchema.nullable().optional(),
  notas: z.string().trim().max(1000).nullable().optional(),
  base64: z.string().optional(),
  mime: z.string().max(60).optional(),
  nombreArchivo: z.string().trim().max(200).optional(),
});

export const POST = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const medico = await prisma.hospMedico.findUnique({ where: { id }, select: { id: true, companyId: true, nombre: true } });
  if (!medico) throw new AuthzError(404, "Médico no encontrado");
  const { user } = await requireWriter(medico.companyId, req);
  await requireModule(medico.companyId, "HOSPITAL", req);

  let archivo: Buffer | null = null;
  if (d.base64) {
    if (!d.mime || !MIMES.includes(d.mime)) return error("El archivo debe ser PDF o imagen (JPG, PNG, WEBP, HEIC)");
    archivo = Buffer.from(d.base64.replace(/^data:[^;]+;base64,/, ""), "base64");
    if (archivo.byteLength === 0) return error("El archivo llegó vacío");
    if (archivo.byteLength > MAX_BYTES) return error("El archivo pesa más de 8 MB", 413);
  }
  if (!archivo && !d.numero && !d.vigenciaHasta) return error("Sube el archivo o captura al menos el número o la vigencia");

  const doc = await prisma.hospMedicoDocumento.create({
    data: {
      companyId: medico.companyId, medicoId: id, tipo: d.tipo, numero: d.numero || null, emitidoPor: d.emitidoPor || null,
      vigenciaHasta: aFecha(d.vigenciaHasta ?? null), notas: d.notas || null,
      ...(archivo ? { archivo: new Uint8Array(archivo), mime: d.mime, bytes: archivo.byteLength, nombreArchivo: d.nombreArchivo || null } : {}),
      subidoPorUserId: user.id,
    },
    select: selectDocumento,
  });
  // La cédula capturada aquí alimenta la ficha si estaba vacía.
  if (d.numero && (d.tipo === "CEDULA_PROFESIONAL" || d.tipo === "CEDULA_ESPECIALIDAD")) {
    const campo = d.tipo === "CEDULA_PROFESIONAL" ? "cedula" : "cedulaEspecialidad";
    await prisma.hospMedico.updateMany({ where: { id, [campo]: null }, data: { [campo]: d.numero } });
  }
  bitacora(user, req, { companyId: medico.companyId, accion: "hospital.medico.documento", entidad: "HospMedico", entidadId: id, detalle: { medico: medico.nombre, tipo: d.tipo, archivo: !!archivo } });
  return NextResponse.json(doc, { status: 201 });
});
