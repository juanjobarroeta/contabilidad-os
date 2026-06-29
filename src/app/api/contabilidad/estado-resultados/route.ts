import { NextResponse } from "next/server";
import { AuthzError, requireMembership } from "@/lib/authz";
import { estadoResultados, estadoResultadosPreview } from "@/lib/contabilidad/posting";
import { prisma } from "@/lib/prisma";

// GET /api/contabilidad/estado-resultados?companyId=xxx&year=2026&month=3
//
// Si el periodo está POSTED/CLOSED → cifras reales del ledger (como siempre).
// Si el periodo no existe o está en DRAFT → cálculo PRELIMINAR directo de los
// CFDIs (preliminar: true), sin tocar el ledger, para no mostrar "Sin
// movimientos" cuando todavía hay facturas que sí dan cifras.
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

    if (isPosted) {
      const result = await estadoResultados(companyId, year, month);
      return NextResponse.json({ ...result, preliminar: false });
    }

    const preview = await estadoResultadosPreview(companyId, year, month);
    return NextResponse.json({ ...preview, preliminar: true });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
