/**
 * GET  /api/hospital/episodios/[id]/depositos → { depositos: [...], resumen: { recibidos, aplicados, devueltos, cancelados, vigentes } }
 * POST /api/hospital/episodios/[id]/depositos { fecha, monto, formaPago: EFECTIVO|TRANSFERENCIA|TARJETA|CHEQUE, referencia?, notas? } → 201 depósito
 *
 * El depósito nace RECIBIDO y, con la contabilidad activa, deja su asiento
 * (CAJA/BANCOS contra ANTICIPOS_PACIENTES) en la misma transacción. Cambios
 * de estado: PATCH /api/hospital/depositos/[id]. Ver src/lib/hospital/depositos.ts.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { aFecha, bitacora, dinero, errorZod, fechaSchema } from "@/lib/hospital/http";
import { FORMAS_PAGO, crearDeposito, depositoResumen, resumenDepositos } from "@/lib/hospital/depositos";

type Ctx = { params: Promise<{ id: string }> };

async function episodioDe(id: string) {
  const ep = await prisma.hospEpisodio.findUnique({ where: { id }, select: { id: true, companyId: true, folio: true } });
  if (!ep) throw new AuthzError(404, "Episodio no encontrado");
  return ep;
}

export const GET = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const ep = await episodioDe(id);
  await requireMembership(ep.companyId, undefined, req);
  await requireModule(ep.companyId, "HOSPITAL", req);

  const depositos = await prisma.hospDeposito.findMany({ where: { episodioId: ep.id }, orderBy: [{ fecha: "asc" }, { createdAt: "asc" }] });
  return NextResponse.json({ depositos: depositos.map(depositoResumen), resumen: resumenDepositos(depositos) });
});

const postSchema = z.object({
  fecha: fechaSchema.nullable().optional(),
  monto: dinero.positive(),
  formaPago: z.enum(FORMAS_PAGO),
  referencia: z.string().trim().max(80).nullable().optional(),
  notas: z.string().trim().max(1000).nullable().optional(),
});

export const POST = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const ep = await episodioDe(id);
  const { user } = await requireWriter(ep.companyId, req);
  await requireModule(ep.companyId, "HOSPITAL", req);

  const deposito = await crearDeposito(prisma, {
    companyId: ep.companyId,
    episodioId: ep.id,
    fecha: aFecha(d.fecha) ?? new Date(),
    monto: d.monto,
    formaPago: d.formaPago,
    referencia: d.referencia ?? null,
    notas: d.notas ?? null,
    usuarioId: user.id,
  });

  bitacora(user, req, {
    companyId: ep.companyId,
    accion: "hospital.deposito.recibir",
    entidad: "HospDeposito",
    entidadId: deposito.id,
    detalle: { folio: ep.folio, monto: Number(deposito.monto), formaPago: deposito.formaPago, asentado: !!deposito.asientoAt },
  });
  return NextResponse.json(depositoResumen(deposito), { status: 201 });
});
