/**
 * GET  /api/hospital/nomina/ptu?companyId&ejercicio&montoTotal&fechaPago?&excluir=a,b
 *      Vista previa del reparto (mitad por días, mitad por salarios; tope de
 *      3 meses o el promedio de 3 años; fuera quien trabajó < 60 días).
 *      `excluir` = directores o administradores generales (Art. 127 fr. I).
 * POST /api/hospital/nomina/ptu { companyId, ejercicio, montoTotal, fechaPago?, items: [{ employeeId, monto? }] }
 *      Crea la corrida tipo PTU (CALCULATED → revisar → timbrar en /nomina).
 *
 * El motor es el del hub (lib/nomina/corridas-especiales.ts), el mismo de
 * /api/nomina/run/ptu.
 * Puerta del hospital: página nomina; crear exige FINANZAS_ESCRIBIR.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod, fechaSchema } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import { crearCorridaPtu, previewPtu } from "@/lib/nomina/corridas-especiales";

const ejercicio = z.coerce.number().int().min(2000).max(2100);
const montoTotal = z.coerce.number().positive("montoTotal debe ser mayor a cero").max(1_000_000_000);

export const GET = withHospital(async (req: Request) => {
  const sp = new URL(req.url).searchParams;
  const companyId = sp.get("companyId");
  if (!companyId) return error("companyId requerido");
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);
  const parsed = z
    .object({ ejercicio, montoTotal, fechaPago: fechaSchema.optional() })
    .safeParse({ ejercicio: sp.get("ejercicio"), montoTotal: sp.get("montoTotal"), fechaPago: sp.get("fechaPago") || undefined });
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;
  const excluirIds = (sp.get("excluir") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return NextResponse.json(
    await previewPtu({ companyId, ejercicio: d.ejercicio, montoTotal: d.montoTotal, fechaPago: d.fechaPago ? new Date(d.fechaPago) : undefined, excluirIds })
  );
});

const schema = z.object({
  companyId: z.string().min(1),
  ejercicio,
  montoTotal,
  fechaPago: fechaSchema.optional(),
  items: z.array(z.object({ employeeId: z.string().min(1), monto: z.number().min(0).optional() })).min(1, "items requeridos: [{ employeeId, monto? }]"),
});

export const POST = withHospital(async (req: Request) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;
  const { user } = await requireWriter(d.companyId, req);
  await requireModule(d.companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  const r = await crearCorridaPtu({
    companyId: d.companyId,
    ejercicio: d.ejercicio,
    montoTotal: d.montoTotal,
    fechaPago: d.fechaPago ? new Date(d.fechaPago) : undefined,
    items: d.items,
  });
  if (!r.ok) return error(r.error ?? "No se pudo crear la corrida");
  bitacora(user, req, {
    companyId: d.companyId,
    accion: "nomina.corrida.ptu",
    entidad: "PayrollRun",
    entidadId: r.runId ?? null,
    detalle: { ejercicio: d.ejercicio, montoTotal: d.montoTotal, empleados: d.items.length },
  });
  return NextResponse.json(r, { status: 201 });
});
