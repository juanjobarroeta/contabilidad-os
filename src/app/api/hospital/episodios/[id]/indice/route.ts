/**
 * PUT /api/hospital/episodios/[id]/indice { ajustes: { "<renglón>": "SI" | "NO" | "NA" } }
 *     → guarda las correcciones a mano del índice del expediente clínico.
 *       Sustituye las anteriores; {} vuelve a lo calculado. El cálculo vive
 *       en el satélite (lib/indice.js): aquí sólo se guarda lo que la persona
 *       corrigió y queda en la bitácora.
 *   400 renglón o valor inválido · 404 · 409 episodio cancelado
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod } from "@/lib/hospital/http";

const schema = z.object({
  ajustes: z.record(z.string().regex(/^\d{1,2}(-\d{1,2}(\.\d)?)?$/, "Renglón inválido"), z.enum(["SI", "NO", "NA"])).refine((a) => Object.keys(a).length <= 40, "Demasiados renglones"),
});

export const PUT = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);

  const ep = await prisma.hospEpisodio.findUnique({ where: { id }, select: { id: true, companyId: true, estado: true, folio: true, indiceAjustes: true } });
  if (!ep) throw new AuthzError(404, "Episodio no encontrado");

  const { user } = await requireWriter(ep.companyId, req);
  await requireModule(ep.companyId, "HOSPITAL", req);
  if (ep.estado === "CANCELADO") return error(`El episodio ${ep.folio} está cancelado`, 409);

  const { ajustes } = parsed.data;
  await prisma.hospEpisodio.update({ where: { id: ep.id }, data: { indiceAjustes: ajustes } });

  bitacora(user, req, {
    companyId: ep.companyId,
    accion: "hospital.episodio.indice",
    entidad: "HospEpisodio",
    entidadId: ep.id,
    detalle: { folio: ep.folio, antes: ep.indiceAjustes ?? {}, despues: ajustes },
  });

  return NextResponse.json({ indiceAjustes: ajustes });
});
