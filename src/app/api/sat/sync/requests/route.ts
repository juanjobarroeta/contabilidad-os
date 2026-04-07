import { NextResponse } from "next/server";
import { AuthzError, requireMembership } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

// GET /api/sat/sync/requests?companyId=xxx&year=2026&month=3
// Returns recent SatSyncRequest rows for the period (or all recent if no period).
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const companyId = url.searchParams.get("companyId");
    if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

    await requireMembership(companyId);

    const yearStr = url.searchParams.get("year");
    const monthStr = url.searchParams.get("month");
    const where: { companyId: string; year?: number; month?: number } = { companyId };
    if (yearStr) where.year = parseInt(yearStr);
    if (monthStr) where.month = parseInt(monthStr);

    const rows = await prisma.satSyncRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return NextResponse.json({ requests: rows });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
