/**
 * POST /api/hospital/farmacia/factores/recalcular { companyId, aplicar?: boolean, soloSinPrecio?: boolean }
 *
 * Recalcula con la tabla de factores el precio de venta de los insumos activos
 * con costo y sin precio fijo (o sólo los que no tienen precio). Sin
 * `aplicar` es la vista previa: cuántos cambian, cuántos suben o bajan y una
 * muestra. Exige FINANZAS_ESCRIBIR.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import { requireClinicalPermission } from "@/lib/hospital/permisos";
import { recalcularPrecios, tablaDe } from "@/lib/hospital/factores-precio";

export const maxDuration = 120;

const schema = z.object({ companyId: z.string().min(1), aplicar: z.boolean().optional(), soloSinPrecio: z.boolean().optional() });

export const POST = withHospital(async (req: Request) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Datos inválidos");
  const { companyId, aplicar = false, soloSinPrecio = false } = parsed.data;
  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);
  if (aplicar) {
    await assertPuedeEscribir(user.id);
    await requireClinicalPermission(companyId, user.id, "FINANZAS_ESCRIBIR");
  }
  const tabla = await tablaDe(prisma, companyId);
  if (!tabla) return error("Primero guarda la tabla de factores", 409);
  const r = await recalcularPrecios(prisma, companyId, tabla, { aplicar, soloSinPrecio });
  if (aplicar) bitacora(user, req, { companyId, accion: "hospital.farmacia.factores.aplicar", entidad: "HospConfig", entidadId: companyId, detalle: { cambian: r.cambian, soloSinPrecio } });
  return NextResponse.json({ aplicado: aplicar, ...r });
});
