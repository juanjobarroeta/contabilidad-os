import { NextResponse } from "next/server";
import { AuthzError, requireWriter } from "@/lib/authz";
import { runAuditForCompany } from "@/lib/fiscal/audit/service";

// POST /api/hallazgos/run  { companyId, fechaIso? }
// Corre el auditor fiscal bajo demanda para una empresa (el cron lo hace en
// lote). Idempotente: re-corre upsertan los hallazgos y preservan el estado
// (RESUELTO/IGNORADO) que el contador haya fijado. `fechaIso` ancla los checks
// por mes (p. ej. ISN); por defecto, hoy.
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const companyId = body?.companyId;
    if (!companyId || typeof companyId !== "string") {
      return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
    }
    const fechaIso = typeof body?.fechaIso === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.fechaIso)
      ? body.fechaIso
      : undefined;

    await requireWriter(companyId, req);
    const result = await runAuditForCompany(companyId, fechaIso);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
