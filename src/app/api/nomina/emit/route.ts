import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthzError, requireWriter } from "@/lib/authz";
import { emitNominaCfdi } from "@/lib/nomina/emit-nomina";

const bodySchema = z.object({
  companyId: z.string().min(1),
  employeeId: z.string().min(1),
  periodoInicio: z.string().min(1),
  periodoFin: z.string().min(1),
  diasPagados: z.number().int().positive().max(31),
  fechaPago: z.string().min(1),
  sueldoBruto: z.number().positive().optional(),
});

// POST /api/nomina/emit
// Body: { companyId, employeeId, periodoInicio, periodoFin, diasPagados, fechaPago, sueldoBruto? }
// Calcula percepciones/deducciones, emite CFDI nómina vía Facturapi, persiste.
export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Datos inválidos" },
        { status: 400 }
      );
    }
    const { companyId, employeeId, periodoInicio, periodoFin, diasPagados, fechaPago, sueldoBruto } = parsed.data;

    await requireWriter(companyId);

    const result = await emitNominaCfdi({
      companyId,
      employeeId,
      periodoInicio: new Date(periodoInicio),
      periodoFin: new Date(periodoFin),
      diasPagados,
      fechaPago: new Date(fechaPago),
      sueldoBruto,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 422 });
    }

    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
