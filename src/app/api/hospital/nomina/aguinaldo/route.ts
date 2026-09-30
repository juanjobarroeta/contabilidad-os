/**
 * GET  /api/hospital/nomina/aguinaldo?companyId&ejercicio&diasAguinaldo?&fechaPago?
 *      Vista previa por empleado activo (proporcional por fecha de alta,
 *      exención de 30 UMA, ISR y neto estimados).
 * POST /api/hospital/nomina/aguinaldo { companyId, ejercicio, diasAguinaldo?, fechaPago?, items?: [{ employeeId, monto? }] }
 *      Crea la corrida tipo AGUINALDO (queda CALCULATED y sigue el flujo
 *      normal: revisar → timbrar en /nomina). `monto` = ajuste manual.
 *
 * El motor es el del hub (lib/nomina/corridas-especiales.ts), el mismo de
 * /api/nomina/run/aguinaldo.
 * Puerta del hospital: página nomina; crear exige FINANZAS_ESCRIBIR.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod, fechaSchema } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import { crearCorridaAguinaldo, previewAguinaldo } from "@/lib/nomina/corridas-especiales";
import { DIAS_AGUINALDO_MINIMO } from "@/lib/nomina/constants";

const ejercicio = z.coerce.number().int().min(2000).max(2100);
const dias = z.coerce.number().min(DIAS_AGUINALDO_MINIMO, `Los días de aguinaldo deben ser al menos ${DIAS_AGUINALDO_MINIMO} (Art. 87 LFT).`).max(365);

export const GET = withHospital(async (req: Request) => {
  const sp = new URL(req.url).searchParams;
  const companyId = sp.get("companyId");
  if (!companyId) return error("companyId requerido");
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);
  const parsed = z
    .object({ ejercicio, diasAguinaldo: dias.optional(), fechaPago: fechaSchema.optional() })
    .safeParse({
      ejercicio: sp.get("ejercicio") ?? new Date().getFullYear(),
      diasAguinaldo: sp.get("diasAguinaldo") || undefined,
      fechaPago: sp.get("fechaPago") || undefined,
    });
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;
  return NextResponse.json(
    await previewAguinaldo({ companyId, ejercicio: d.ejercicio, diasAguinaldo: d.diasAguinaldo, fechaPago: d.fechaPago ? new Date(d.fechaPago) : undefined })
  );
});

const schema = z.object({
  companyId: z.string().min(1),
  ejercicio,
  diasAguinaldo: dias.optional(),
  fechaPago: fechaSchema.optional(),
  items: z.array(z.object({ employeeId: z.string().min(1), monto: z.number().min(0).optional() })).optional(),
});

export const POST = withHospital(async (req: Request) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;
  const { user } = await requireWriter(d.companyId, req);
  await requireModule(d.companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  const r = await crearCorridaAguinaldo({
    companyId: d.companyId,
    ejercicio: d.ejercicio,
    diasAguinaldo: d.diasAguinaldo,
    fechaPago: d.fechaPago ? new Date(d.fechaPago) : undefined,
    items: d.items,
  });
  if (!r.ok) return error(r.error ?? "No se pudo crear la corrida");
  bitacora(user, req, {
    companyId: d.companyId,
    accion: "nomina.corrida.aguinaldo",
    entidad: "PayrollRun",
    entidadId: r.runId ?? null,
    detalle: { ejercicio: d.ejercicio, diasAguinaldo: d.diasAguinaldo ?? DIAS_AGUINALDO_MINIMO, empleados: d.items?.length ?? null },
  });
  return NextResponse.json(r, { status: 201 });
});
