/**
 * POST /api/hospital/cotizaciones/[id]/convertir
 *   { tipo, recursoId?, medicoId?, fechaIngreso?, pacienteId? (obligatorio si la cotización no tiene), customerId?, diagnostico?, diagnosticoCie10?, motivo? }
 *
 * «Al ingresar, se vuelve su cuenta»: abre el episodio con crearEpisodio,
 * que copia las partidas como cargos (origen COTIZACION) y marca CONVERTIDA.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { aFecha, bitacora, error, errorZod, fechaSchema, usuarioDe } from "@/lib/hospital/http";
import { crearEpisodio } from "@/lib/hospital/episodio";
import { customerResumen, medicoResumen, pacienteResumen } from "@/lib/hospital/serializar";

const schema = z.object({
  tipo: z.enum(["HOSPITALIZACION", "AMBULATORIO", "URGENCIAS", "CONSULTA"]),
  recursoId: z.string().nullable().optional(),
  medicoId: z.string().nullable().optional(),
  fechaIngreso: fechaSchema.nullable().optional(),
  pacienteId: z.string().nullable().optional(),
  customerId: z.string().nullable().optional(),
  diagnostico: z.string().max(300).nullable().optional(),
  diagnosticoCie10: z.string().max(10).nullable().optional(),
  motivo: z.string().max(1000).nullable().optional(),
  autorizacionPagador: z.string().max(80).nullable().optional(),
});

export const POST = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const c = await prisma.hospCotizacion.findUnique({ where: { id }, select: { id: true, companyId: true, folio: true, estado: true, pacienteId: true, pagadorId: true, procedimiento: true } });
  if (!c) throw new AuthzError(404, "Cotización no encontrada");

  const { user } = await requireWriter(c.companyId, req);
  await requireModule(c.companyId, "HOSPITAL", req);

  const pacienteId = c.pacienteId ?? d.pacienteId;
  if (!pacienteId) return error("La cotización no tiene paciente registrado: manda pacienteId");

  const episodio = await crearEpisodio(prisma, {
    companyId: c.companyId,
    pacienteId,
    tipo: d.tipo,
    recursoId: d.recursoId ?? null,
    medicoId: d.medicoId ?? null,
    // El convenio de la cotización manda: con él se preciaron las partidas.
    pagadorId: c.pagadorId,
    customerId: d.customerId,
    diagnostico: d.diagnostico ?? null,
    diagnosticoCie10: d.diagnosticoCie10 ?? null,
    procedimiento: c.procedimiento,
    motivo: d.motivo ?? null,
    autorizacionPagador: d.autorizacionPagador ?? null,
    cotizacionId: c.id,
    fechaIngreso: aFecha(d.fechaIngreso),
    usuario: usuarioDe(user),
  });

  bitacora(user, req, {
    companyId: c.companyId,
    accion: "hospital.cotizacion.convertir",
    entidad: "HospCotizacion",
    entidadId: id,
    detalle: { folio: c.folio, episodioId: episodio.id, episodioFolio: episodio.folio, cargos: episodio.cargos.length },
  });

  return NextResponse.json(
    { ...episodio, paciente: pacienteResumen(episodio.paciente), medico: medicoResumen(episodio.medico), customer: customerResumen(episodio.customer) },
    { status: 201 }
  );
});
