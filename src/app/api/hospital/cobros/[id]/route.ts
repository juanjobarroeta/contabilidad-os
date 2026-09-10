/**
 * PATCH /api/hospital/cobros/[id] { estado: CONTRACARGADO|RECUPERADO|CANCELADO, fecha?, motivo? }
 *
 * DEPOSITADO no se pone aquí: un cobro se marca depositado al armar la
 * liquidación del adquirente (POST /api/hospital/liquidaciones), nunca uno por
 * uno — marcarlo a mano rompería el cuadre del lote.
 *
 * El contracargo reversa el cobro contra FONDOS_EN_TRANSITO aunque el depósito
 * ya hubiera llegado al banco: el adquirente no lo devuelve por separado, lo
 * descuenta del lote del día. Ver src/lib/hospital/cobros.ts.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { aFecha, bitacora, errorZod, fechaSchema } from "@/lib/hospital/http";
import { cambiarEstadoCobro, cobroResumen } from "@/lib/hospital/cobros";

const schema = z.object({
  estado: z.enum(["CONTRACARGADO", "RECUPERADO", "CANCELADO"]),
  fecha: fechaSchema.nullable().optional(),
  motivo: z.string().trim().max(500).nullable().optional(),
});

export const PATCH = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);

  const cobro = await prisma.hospCobro.findUnique({ where: { id }, select: { id: true, companyId: true, estado: true } });
  if (!cobro) throw new AuthzError(404, "Cobro no encontrado");

  const { user } = await requireWriter(cobro.companyId, req);
  await requireModule(cobro.companyId, "HOSPITAL", req);

  const actualizado = await cambiarEstadoCobro(prisma, {
    companyId: cobro.companyId,
    cobroId: cobro.id,
    estado: parsed.data.estado,
    fecha: aFecha(parsed.data.fecha),
    motivo: parsed.data.motivo ?? null,
  });

  bitacora(user, req, {
    companyId: cobro.companyId,
    accion: "hospital.cobro.estado",
    entidad: "HospCobro",
    entidadId: cobro.id,
    detalle: { de: cobro.estado, a: actualizado.estado, monto: Number(actualizado.monto), motivo: actualizado.contracargoMotivo, asentado: !!actualizado.asientoAt },
  });
  return NextResponse.json(cobroResumen(actualizado));
});
