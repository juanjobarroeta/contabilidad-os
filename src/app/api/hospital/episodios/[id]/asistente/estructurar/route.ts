/**
 * POST /api/hospital/episodios/[id]/asistente/estructurar { tipo: HospNotaTipo, texto, contexto?: { signos?: bool } }
 *   → { tipo, secciones: { <clave de PLANTILLAS_NOTA[tipo]>: valor }, faltantes, texto, codigos: { diagnosticos, procedimientos },
 *       advertencias, asistencia: { origen: "ESTRUCTURADO", modelo, at }, uso }
 *
 * El modelo recibe la plantilla, el tipo de episodio, sexo/edad y los signos;
 * el hub se queda con las secciones de la plantilla, valida cada código con el
 * catálogo (existe, activo, sexo/edad) y devuelve la PROPUESTA. Nada se
 * guarda: el médico la revisa y la firma con POST /notas (con `asistencia`).
 * 409 con HospConfig.iaAsistencia = false o episodio cancelado.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, errorZod } from "@/lib/hospital/http";
import { TIPOS_NOTA } from "@/lib/hospital/notas";
import { requireModule, requireWriter } from "@/lib/authz";
import { episodioAsistente, exigirPoliticaAsistente } from "@/lib/hospital/asistente/autorizar";
import { MAX_TEXTO_DICTADO, estructurarNota } from "@/lib/hospital/asistente/estructurar";

export const maxDuration = 120;

const schema = z.object({
  tipo: z.enum(TIPOS_NOTA),
  texto: z.string().min(1).max(MAX_TEXTO_DICTADO),
  contexto: z.object({ signos: z.boolean().optional() }).optional(),
});

export const POST = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const ep = await episodioAsistente(id);
  const { user } = await requireWriter(ep.companyId, req);
  await requireModule(ep.companyId, "HOSPITAL", req);
  await exigirPoliticaAsistente(ep);
  const propuesta = await estructurarNota(prisma, {
    companyId: ep.companyId,
    episodioId: ep.id,
    tipo: d.tipo,
    texto: d.texto,
    userId: user.id,
    contexto: d.contexto,
  });

  bitacora(user, req, {
    companyId: ep.companyId,
    accion: "hospital.asistente.estructurar",
    entidad: "HospEpisodio",
    entidadId: ep.id,
    detalle: {
      folio: ep.folio,
      tipo: d.tipo,
      modelo: propuesta.asistencia.modelo,
      caracteres: d.texto.length,
      secciones: Object.keys(propuesta.secciones).length,
      faltantes: propuesta.faltantes.length,
      codigos: propuesta.codigos.diagnosticos.length + propuesta.codigos.procedimientos.length,
      advertencias: propuesta.advertencias.length,
      intentos: propuesta.uso.intentos,
    },
  });

  return NextResponse.json(propuesta);
});
