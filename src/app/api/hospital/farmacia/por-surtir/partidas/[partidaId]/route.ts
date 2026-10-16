/**
 * GET  /api/hospital/farmacia/por-surtir/partidas/[partidaId]?companyId=…[&q=]
 *      Lo pendiente de la partida, el insumo ligado y candidatos del catálogo
 *      (inventario y derivados de CFDI) con existencia y plan FEFO.
 * POST /api/hospital/farmacia/por-surtir/partidas/[partidaId]
 *      { companyId, episodioId, insumoId, cantidad, loteId?, recetaRef?, medicoId?, prescriptorNombre?, prescriptorCedula?, recordar? }
 *      Surte contra inventario: sale del lote (FEFO), entra a la cuenta al
 *      precio cotizado; lo que pasa de lo cotizado, a precio de lista
 *      (lib/hospital/surtido).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod, usuarioDe } from "@/lib/hospital/http";
import { opcionesSurtido, surtirPartida } from "@/lib/hospital/surtido";

type Ctx = { params: Promise<{ partidaId: string }> };

export const GET = withHospital(async (req: Request, ctx: Ctx) => {
  const { partidaId } = await ctx.params;
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);
  return NextResponse.json(await opcionesSurtido(prisma, companyId, partidaId, searchParams.get("q")));
});

const schema = z.object({
  companyId: z.string().min(1),
  episodioId: z.string().min(1),
  insumoId: z.string().min(1),
  cantidad: z.number().positive().max(100_000),
  loteId: z.string().min(1).nullable().optional(),
  recetaRef: z.string().trim().max(80).nullable().optional(),
  medicoId: z.string().min(1).nullable().optional(),
  prescriptorNombre: z.string().trim().max(200).nullable().optional(),
  prescriptorCedula: z.string().trim().max(40).nullable().optional(),
  recordar: z.boolean().optional(),
});

export const POST = withHospital(async (req: Request, ctx: Ctx) => {
  const { partidaId } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;
  const { user } = await requireWriter(d.companyId, req);
  await requireModule(d.companyId, "HOSPITAL", req);
  const r = await surtirPartida(prisma, { ...d, partidaId, usuario: usuarioDe(user) });
  bitacora(user, req, {
    companyId: d.companyId,
    accion: "hospital.farmacia.surtir-inventario",
    entidad: "HospCotizacionPartida",
    entidadId: partidaId,
    detalle: { episodioId: d.episodioId, insumoId: d.insumoId, cantidad: d.cantidad, cotizado: r.cotizado, extra: r.extra, importe: r.importe, lotes: r.tramos.map((t) => `${t.lote}@${t.almacen}×${t.cantidad}`) },
  });
  return NextResponse.json(r, { status: 201 });
});
