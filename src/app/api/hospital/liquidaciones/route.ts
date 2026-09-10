/**
 * GET  /api/hospital/liquidaciones?companyId=…[&desde&hasta&afiliacionId]
 * POST /api/hospital/liquidaciones { companyId, afiliacionId, fecha, cobroIds[],
 *      bruto, contracargos, comision, ivaComision, neto, bankTransactionId?, notas? } → 201
 *
 * El lote del adquirente. Se acepta sólo si cierra:
 *
 *     bruto − contracargos − comisión − IVA de comisión = neto
 *
 * y si los cobros del lote suman el bruto. Los marca DEPOSITADOS y asienta
 * ÚNICAMENTE la comisión y su IVA contra FONDOS_EN_TRANSITO: bajar el neto a
 * BANCOS es de la conciliación del hub. Ver src/lib/hospital/liquidaciones.ts.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { aFecha, bitacora, dinero, error, errorZod, fechaSchema, rangoDeQuery } from "@/lib/hospital/http";
import { crearLiquidacion, liquidacionResumen } from "@/lib/hospital/liquidaciones";

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const rango = rangoDeQuery(searchParams.get("desde"), searchParams.get("hasta"));
  const afiliacionId = searchParams.get("afiliacionId");

  const liquidaciones = await prisma.hospLiquidacion.findMany({
    where: {
      companyId,
      ...(rango ? { fecha: { gte: rango.desde, lt: rango.hasta } } : {}),
      ...(afiliacionId ? { afiliacionId } : {}),
    },
    include: { cobros: { select: { estado: true } }, afiliacion: { select: { numero: true } } },
    orderBy: [{ fecha: "desc" }, { createdAt: "desc" }],
    take: 200,
  });

  return NextResponse.json({
    liquidaciones: liquidaciones.map((l) => ({ ...liquidacionResumen(l), afiliacion: l.afiliacion.numero })),
  });
});

const postSchema = z.object({
  companyId: z.string().min(1),
  afiliacionId: z.string().min(1),
  fecha: fechaSchema,
  cobroIds: z.array(z.string().min(1)).min(1).max(1000),
  bruto: dinero.positive(),
  contracargos: dinero.default(0),
  comision: dinero,
  ivaComision: dinero,
  neto: dinero,
  bankTransactionId: z.string().nullable().optional(),
  notas: z.string().trim().max(1000).nullable().optional(),
});

export const POST = withHospital(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const { user } = await requireWriter(d.companyId, req);
  await requireModule(d.companyId, "HOSPITAL", req);

  const liquidacion = await crearLiquidacion(prisma, {
    companyId: d.companyId,
    afiliacionId: d.afiliacionId,
    fecha: aFecha(d.fecha)!,
    cobroIds: d.cobroIds,
    bruto: d.bruto,
    contracargos: d.contracargos,
    comision: d.comision,
    ivaComision: d.ivaComision,
    neto: d.neto,
    bankTransactionId: d.bankTransactionId ?? null,
    notas: d.notas ?? null,
  });

  bitacora(user, req, {
    companyId: d.companyId,
    accion: "hospital.liquidacion.registrar",
    entidad: "HospLiquidacion",
    entidadId: liquidacion.id,
    detalle: {
      afiliacionId: d.afiliacionId,
      cobros: d.cobroIds.length,
      bruto: Number(liquidacion.bruto),
      neto: Number(liquidacion.neto),
      conciliada: !!liquidacion.bankTransactionId,
      asentado: !!liquidacion.asientoAt,
    },
  });
  return NextResponse.json(liquidacionResumen(liquidacion), { status: 201 });
});
