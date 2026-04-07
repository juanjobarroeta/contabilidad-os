import { NextResponse } from "next/server";
import { AuthzError, requireMembership } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { getFacturapiClient } from "@/lib/facturapi";

// GET /api/sat/catalogs/units?companyId=xxx&q=pieza
// Searches the SAT unit catalog (claveUnidad).
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const companyId = url.searchParams.get("companyId");
    const q = url.searchParams.get("q")?.trim() ?? "";
    if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

    await requireMembership(companyId);

    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { facturapiApiKey: true },
    });
    if (!company?.facturapiApiKey) {
      return NextResponse.json({ data: [], error: "Empresa sin clave Facturapi" }, { status: 422 });
    }

    const client = getFacturapiClient(company.facturapiApiKey);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const catalogs = (client as any).catalogs;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await catalogs.searchUnits({ q, limit: 25 });
    return NextResponse.json({
      data: (result.data ?? []).map((d: { key?: string; value?: string; name?: string; description?: string; symbol?: string }) => ({
        key: d.key ?? d.value ?? "",
        name: d.name ?? d.description ?? "",
        symbol: d.symbol ?? null,
      })),
    });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    const msg = e instanceof Error ? e.message : "Error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
