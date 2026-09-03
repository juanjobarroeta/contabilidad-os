import { NextResponse } from "next/server";
import { AuthzError, requireWriter } from "@/lib/authz";
import { runAuditForCompany } from "@/lib/fiscal/audit/service";
import { generarSintesisAuditoria } from "@/lib/fiscal/audit/sintesis";
import { asegurarUsoIA, respuestaTopeIA } from "@/lib/ai/guardia";

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

    const { user } = await requireWriter(companyId, req);
    const result = await runAuditForCompany(companyId, fechaIso);
    // La corrida manual re-sintetiza con el modelo (quien apretó el botón quiere
    // la lectura fresca), pero sólo si la empresa tiene tope de IA disponible:
    // el auditor en sí no gasta modelo y siempre corre. Best-effort.
    const guardia = await asegurarUsoIA({ userId: user.id, companyId });
    let sintesis: "ok" | "omitida_por_tope" | "fallo" = "ok";
    if (!guardia.ok) {
      sintesis = "omitida_por_tope";
    } else {
      try {
        await generarSintesisAuditoria(companyId, { userId: user.id });
      } catch (e) {
        sintesis = "fallo";
        console.error("[hallazgos/run] síntesis falló:", e instanceof Error ? e.message : e);
      }
    }
    return NextResponse.json({ ok: true, ...result, sintesis });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
