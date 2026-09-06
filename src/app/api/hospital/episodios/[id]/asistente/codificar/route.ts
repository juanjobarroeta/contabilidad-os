/**
 * POST /api/hospital/episodios/[id]/asistente/codificar { texto?: string }
 *   → { diagnosticos: [{ codigo, clave, nombre, confianza, fragmento, principal }], procedimientos: [...], causaExterna,
 *       advertencias, fuente, asistencia: { origen: "SUGERIDO", modelo, at }, uso }
 *
 * Sin `texto` codifica todas las notas vigentes del episodio; con él, ese
 * texto. Cada código se valida con el catálogo y el paciente; los que no
 * pasan se descartan con advertencia. Propuesta: el médico decide qué acepta.
 * 409 con HospConfig.iaAsistencia = false o episodio cancelado.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, errorZod } from "@/lib/hospital/http";
import { requireModule, requireWriter } from "@/lib/authz";
import { episodioAsistente, exigirPoliticaAsistente } from "@/lib/hospital/asistente/autorizar";
import { MAX_TEXTO_CODIFICAR, codificarEpisodio } from "@/lib/hospital/asistente/codificar";

export const maxDuration = 120;

const schema = z.object({ texto: z.string().max(MAX_TEXTO_CODIFICAR).nullable().optional() });

export const POST = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.text().then((t) => (t.trim() ? JSON.parse(t) : {})).catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);

  const ep = await episodioAsistente(id);
  const { user } = await requireWriter(ep.companyId, req);
  await requireModule(ep.companyId, "HOSPITAL", req);
  await exigirPoliticaAsistente(ep);
  const codificacion = await codificarEpisodio(prisma, { companyId: ep.companyId, episodioId: ep.id, texto: parsed.data.texto ?? null, userId: user.id });

  bitacora(user, req, {
    companyId: ep.companyId,
    accion: "hospital.asistente.codificar",
    entidad: "HospEpisodio",
    entidadId: ep.id,
    detalle: {
      folio: ep.folio,
      modelo: codificacion.asistencia.modelo,
      fuente: codificacion.fuente.origen,
      notas: codificacion.fuente.notasIncluidas,
      diagnosticos: codificacion.diagnosticos.length,
      procedimientos: codificacion.procedimientos.length,
      causaExterna: !!codificacion.causaExterna,
      advertencias: codificacion.advertencias.length,
      intentos: codificacion.uso.intentos,
    },
  });

  return NextResponse.json(codificacion);
});
