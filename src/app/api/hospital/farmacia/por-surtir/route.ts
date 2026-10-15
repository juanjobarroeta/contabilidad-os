/**
 * GET  /api/hospital/farmacia/por-surtir?companyId=…
 *      { agendadas, porCargar } — medicamento y material cotizados: de citas
 *      agendadas (para preparar) y de episodios ya ingresados (para cargar).
 * POST /api/hospital/farmacia/por-surtir { companyId, episodioId, partidaIds[] }
 *      Los pasa a la cuenta del paciente al precio cotizado (lib/hospital/por-surtir).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod, usuarioDe } from "@/lib/hospital/http";
import { cargarPorSurtir, listarPorSurtir } from "@/lib/hospital/por-surtir";

export const GET = withHospital(async (req: Request) => {
  const companyId = new URL(req.url).searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);
  return NextResponse.json(await listarPorSurtir(prisma, companyId));
});

const schema = z.object({
  companyId: z.string().min(1),
  episodioId: z.string().min(1),
  partidaIds: z.array(z.string().min(1)).min(1).max(200),
});

export const POST = withHospital(async (req: Request) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;
  const { user } = await requireWriter(d.companyId, req);
  await requireModule(d.companyId, "HOSPITAL", req);
  const r = await cargarPorSurtir(prisma, { companyId: d.companyId, episodioId: d.episodioId, partidaIds: d.partidaIds, usuario: usuarioDe(user) });
  bitacora(user, req, { companyId: d.companyId, accion: "hospital.farmacia.surtir-cotizado", entidad: "HospEpisodio", entidadId: d.episodioId, detalle: { ...r, partidas: d.partidaIds.length } });
  return NextResponse.json(r, { status: 201 });
});
