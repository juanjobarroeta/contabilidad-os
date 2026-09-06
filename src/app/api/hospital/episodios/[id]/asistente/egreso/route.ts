/**
 * POST /api/hospital/episodios/[id]/asistente/egreso
 *   → { tipo: "EGRESO", secciones: { diagnosticoEgreso, motivoEgreso, evolucion, planManejo, problemasPendientes?, pronostico?,
 *       recomendaciones?, causaDefuncion?, diasEstancia }, faltantes, texto, motivoEgresoClave, aldrete, diasEstancia,
 *       codigos: { diagnosticos, procedimientos }, saeh: { afeccionPrincipal, comorbilidades, procedimientos, causaExterna },
 *       advertencias, notas: { incluidas, omitidas }, asistencia: { origen: "SUGERIDO", modelo, at }, uso }
 *
 * Borrador de la nota de egreso armado con TODAS las notas vigentes del
 * episodio en orden cronológico, más las sugerencias para la hoja SAEH
 * (GET /saeh?sugerencias=1 devuelve lo mismo). Propuesta: se firma con POST
 * /notas o al dar el alta. 409 con iaAsistencia = false, cancelado o sin notas.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora } from "@/lib/hospital/http";
import { requireModule, requireWriter } from "@/lib/authz";
import { episodioAsistente, exigirPoliticaAsistente } from "@/lib/hospital/asistente/autorizar";
import { proponerEgreso } from "@/lib/hospital/asistente/egreso";

export const maxDuration = 120;

export const POST = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const ep = await episodioAsistente(id);
  const { user } = await requireWriter(ep.companyId, req);
  await requireModule(ep.companyId, "HOSPITAL", req);
  await exigirPoliticaAsistente(ep);
  const propuesta = await proponerEgreso(prisma, { companyId: ep.companyId, episodioId: ep.id, userId: user.id });

  bitacora(user, req, {
    companyId: ep.companyId,
    accion: "hospital.asistente.egreso",
    entidad: "HospEpisodio",
    entidadId: ep.id,
    detalle: {
      folio: ep.folio,
      modelo: propuesta.asistencia.modelo,
      notas: propuesta.notas.incluidas,
      faltantes: propuesta.faltantes.length,
      motivoEgresoClave: propuesta.motivoEgresoClave,
      diagnosticos: propuesta.codigos.diagnosticos.length,
      procedimientos: propuesta.codigos.procedimientos.length,
      advertencias: propuesta.advertencias.length,
      intentos: propuesta.uso.intentos,
    },
  });

  return NextResponse.json(propuesta);
});
