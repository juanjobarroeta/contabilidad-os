/**
 * GET  /api/hospital/pacientes/[id]/documentos[?episodioId=]
 *      → documentos del paciente (episodioId null) y, si se pide, los del
 *        episodio; con sus firmas (sin imagen) y sin bytes ni texto firmado.
 * POST /api/hospital/pacientes/[id]/documentos { tipo, episodioId?, contenido?, plantillaVersion?, nombre?, requerido? }
 *      → registra un documento con su plantilla legal resuelta (textoFirmado,
 *        hashContenido, firmasRequeridas, plantillaVersion) listo para
 *        POST /api/hospital/documentos/[docId]/firmas; los tipos sin plantilla
 *        (identificación, póliza…) nacen PENDIENTE a la espera del archivo.
 *        `plantillaVersion` distinta de la vigente → 409.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod } from "@/lib/hospital/http";
import { crearDocumentoConPlantilla, listarDocumentosPaciente } from "@/lib/hospital/admision";
import { TIPOS_DOCUMENTO } from "@/lib/hospital/documentos";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const paciente = await prisma.hospPaciente.findUnique({ where: { id }, select: { id: true, companyId: true } });
  if (!paciente) throw new AuthzError(404, "Paciente no encontrado");

  await requireMembership(paciente.companyId, undefined, req);
  await requireModule(paciente.companyId, "HOSPITAL", req);

  const episodioId = new URL(req.url).searchParams.get("episodioId");
  if (episodioId) {
    const ep = await prisma.hospEpisodio.findUnique({ where: { id: episodioId }, select: { pacienteId: true } });
    if (!ep || ep.pacienteId !== paciente.id) return error("episodioId no es de este paciente", 404);
  }
  return NextResponse.json(await listarDocumentosPaciente(prisma, { pacienteId: paciente.id, episodioId }));
});

const schema = z.object({
  tipo: z.enum(TIPOS_DOCUMENTO),
  episodioId: z.string().nullable().optional(),
  nombre: z.string().trim().min(1).max(200).nullable().optional(),
  requerido: z.boolean().optional(),
  contenido: z.record(z.string(), z.unknown()).nullable().optional(),
  plantillaVersion: z.string().trim().max(40).nullable().optional(),
});

export const POST = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const paciente = await prisma.hospPaciente.findUnique({ where: { id }, select: { id: true, companyId: true, expedienteNumero: true } });
  if (!paciente) throw new AuthzError(404, "Paciente no encontrado");

  const { user } = await requireWriter(paciente.companyId, req);
  await requireModule(paciente.companyId, "HOSPITAL", req);

  const { documento, advertencias } = await crearDocumentoConPlantilla(prisma, {
    companyId: paciente.companyId,
    pacienteId: paciente.id,
    episodioId: d.episodioId ?? null,
    tipo: d.tipo,
    nombre: d.nombre,
    requerido: d.requerido,
    contenido: d.contenido ?? null,
    plantillaVersion: d.plantillaVersion,
    user,
  });

  bitacora(user, req, {
    companyId: paciente.companyId,
    accion: "hospital.documento.crear",
    entidad: "HospDocumento",
    entidadId: documento.id,
    detalle: { expediente: paciente.expedienteNumero, episodioId: documento.episodioId, tipo: d.tipo, nombre: documento.nombre, plantillaVersion: documento.plantillaVersion, hashContenido: documento.hashContenido },
  });

  return NextResponse.json({ ...documento, advertencias }, { status: 201 });
});
