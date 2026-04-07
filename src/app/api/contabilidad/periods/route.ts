import { NextResponse } from "next/server";
import { AuthzError, requireMembership } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

// GET /api/contabilidad/periods?companyId=xxx
// Returns all posted periods + current-year empty ones so the UI shows a
// full year grid.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const companyId = url.searchParams.get("companyId");
    if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

    await requireMembership(companyId);

    const periods = await prisma.accountingPeriod.findMany({
      where: { companyId },
      orderBy: [{ year: "desc" }, { month: "desc" }],
    });

    return NextResponse.json(periods);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
