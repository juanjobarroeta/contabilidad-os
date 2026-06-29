import { NextResponse } from "next/server";
import { AuthzError, requireMembership } from "@/lib/authz";
import { evaluarReadinessCE } from "@/lib/contabilidad/ce-readiness";

// GET /api/contabilidad/ce-readiness?companyId=xxx&year=2026&month=3
//
// Devuelve el estado de preparación de la Contabilidad Electrónica del periodo:
// estado global (lista | con_huecos | incompleta) + lista de checks con su CTA.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const companyId = url.searchParams.get("companyId");
    const year = parseInt(url.searchParams.get("year") ?? "");
    const month = parseInt(url.searchParams.get("month") ?? "");
    if (!companyId || !year || !month) {
      return NextResponse.json({ error: "companyId, year, month requeridos" }, { status: 400 });
    }

    await requireMembership(companyId);

    const result = await evaluarReadinessCE(companyId, year, month);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
