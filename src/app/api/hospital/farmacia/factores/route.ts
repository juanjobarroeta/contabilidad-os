/**
 * GET /api/hospital/farmacia/factores?companyId=
 *     La tabla de factores de precio (o null si no hay) y la sugerida (la del
 *     hospital, 2025) para empezar.
 * PUT /api/hospital/farmacia/factores { companyId, tramos: [{ hasta | null, factor }] | null }
 *     Guarda la tabla (null la quita: el precio vuelve a capturarse a mano).
 *     No recalcula nada: eso es …/factores/recalcular, con vista previa.
 *     Exige FINANZAS_ESCRIBIR.
 *
 * Motor: lib/hospital/factores-precio.ts.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import { requireClinicalPermission } from "@/lib/hospital/permisos";
import { TABLA_SUGERIDA, tablaDe, tablaSchema } from "@/lib/hospital/factores-precio";

export const GET = withHospital(async (req: Request) => {
  const companyId = new URL(req.url).searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);
  const [tramos, insumos] = await Promise.all([
    tablaDe(prisma, companyId),
    prisma.hospInsumo.groupBy({ by: ["precioFijo"], where: { companyId, activo: true }, _count: { _all: true } }),
  ]);
  const fijos = insumos.find((x) => x.precioFijo)?._count._all ?? 0;
  const porTabla = insumos.find((x) => !x.precioFijo)?._count._all ?? 0;
  return NextResponse.json({ tramos, sugerida: TABLA_SUGERIDA, insumos: { fijos, porTabla } });
});

const schema = z.object({ companyId: z.string().min(1), tramos: tablaSchema.nullable() });

export const PUT = withHospital(async (req: Request) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Datos inválidos");
  const { companyId, tramos } = parsed.data;
  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  await requireClinicalPermission(companyId, user.id, "FINANZAS_ESCRIBIR");
  const valor = tramos ?? Prisma.DbNull;
  await prisma.hospConfig.upsert({ where: { companyId }, create: { companyId, factoresPrecio: valor }, update: { factoresPrecio: valor } });
  bitacora(user, req, { companyId, accion: "hospital.farmacia.factores", entidad: "HospConfig", entidadId: companyId, detalle: { tramos } });
  return NextResponse.json({ tramos });
});
