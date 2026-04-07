import { NextResponse } from "next/server";
import { AuthzError, requireMembership } from "@/lib/authz";
import { balanza } from "@/lib/contabilidad/posting";

// GET /api/contabilidad/balanza?companyId=xxx&year=2026&month=3
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

    const rows = await balanza(companyId, year, month);
    return NextResponse.json({ rows });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
