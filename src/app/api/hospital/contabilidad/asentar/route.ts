/**
 * POST /api/hospital/contabilidad/asentar { companyId, anio, mes }
 *   → { ok, asentados, revisados, periodo }
 *
 * Lleva al libro (fuente HOSPITAL) lo pendiente del mes: salidas de farmacia
 * sin costo asentado, honorarios de altas del mes sin retención asentada y
 * etapas de depósitos que aún no están. Idempotente: lo que ya está por
 * (referencia, tipo) no se repite. 409 si la contabilidad no está activa o el
 * ejercicio está cerrado. Ver src/lib/hospital/asientos.ts.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, errorZod } from "@/lib/hospital/http";
import { asentarMes } from "@/lib/hospital/asientos";

const schema = z.object({
  companyId: z.string().min(1),
  anio: z.number().int().min(2000).max(2100),
  mes: z.number().int().min(1).max(12),
});

export const POST = withHospital(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const { companyId, anio, mes } = parsed.data;

  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);

  const resultado = await asentarMes(prisma, companyId, anio, mes);

  bitacora(user, req, {
    companyId,
    accion: "hospital.contabilidad.asentar",
    entidad: "AccountingEntry",
    entidadId: `${companyId}:${anio}-${mes}`,
    detalle: { anio, mes, ...resultado },
  });
  return NextResponse.json({ ok: true, ...resultado, periodo: { anio, mes } });
});
