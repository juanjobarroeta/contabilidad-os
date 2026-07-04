import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthzError, requireScope, requireWriter } from "@/lib/authz";
import { assertPuedeEscribir } from "@/lib/subscription";
import { emitNominaCfdi } from "@/lib/nomina/emit-nomina";
import { registrarBitacora } from "@/lib/audit";

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

    // Pass `req` so bearer-token (satellite/M2M) callers are accepted, not just
    // the NextAuth web session — lets ZionX mirror payroll into CFDI de nómina.
    // Membership (requireWriter) still enforces multi-tenancy.
    const { user } = await requireWriter(companyId, req);
    requireScope(user, "nomina"); // sólo aplica a tokens emitidos con scope
    // Gating de suscripción (bandera SUBSCRIPTION_ENFORCEMENT_ENABLED); el 402
    // fluye por el catch de AuthzError de abajo.
    await assertPuedeEscribir(user.id);

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

    // Bitácora de seguridad: CFDI de nómina emitido (fire-and-forget).
    registrarBitacora({
      companyId,
      userId: user.id,
      actorEmail: user.email,
      accion: "nomina.timbrar",
      entidad: "Employee",
      entidadId: employeeId,
      detalle: {
        uuid: result.uuid ?? null,
        periodoInicio,
        periodoFin,
        diasPagados,
      },
      req,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
