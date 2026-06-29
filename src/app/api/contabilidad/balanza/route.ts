import { NextResponse } from "next/server";
import { AuthzError, requireMembership } from "@/lib/authz";
import { balanza, balanzaPreview } from "@/lib/contabilidad/posting";
import { prisma } from "@/lib/prisma";

// GET /api/contabilidad/balanza?companyId=xxx&year=2026&month=3
//
// Si el periodo está POSTED/CLOSED → balanza real del ledger (como siempre).
// Si el periodo no existe o está en DRAFT → balanza PRELIMINAR derivada de los
// CFDIs (preliminar: true), sin tocar el ledger.
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

    const period = await prisma.accountingPeriod.findUnique({
      where: { companyId_year_month: { companyId, year, month } },
      select: { status: true },
    });
    const isPosted = period?.status === "POSTED" || period?.status === "CLOSED";

    const rows = isPosted
      ? await balanza(companyId, year, month)
      : await balanzaPreview(companyId, year, month);

    return NextResponse.json({ rows, preliminar: !isPosted });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
