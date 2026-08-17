import { NextResponse } from "next/server";
import { AuthzError, requireMembership } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { getFacturapiClient } from "@/lib/facturapi";

// GET /api/sat/catalogs/products?companyId=xxx&q=agua
// Searches the SAT product/service catalog (claveProdServ).
// Proxies Facturapi's /catalogs/products endpoint so the master key isn't
// exposed to the browser.
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

    const client = getFacturapiClient(company.facturapiApiKey, {
      companyId,
      actor: "route:sat-catalogs",
    });
    // The Facturapi node SDK has `catalogs` at runtime but it's missing from
    // the TS types. Cast through any to access it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const catalogs = (client as any).catalogs;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await catalogs.searchProducts({ q, limit: 25 });
    // Result shape: { data: [{ key: "...", description: "..." }], total_results }
    return NextResponse.json({
      data: (result.data ?? []).map((d: { key?: string; value?: string; description?: string }) => ({
        key: d.key ?? d.value ?? "",
        description: d.description ?? "",
      })),
    });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    const msg = e instanceof Error ? e.message : "Error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
