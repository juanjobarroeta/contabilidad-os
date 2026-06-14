import { NextResponse } from "next/server";
import { AuthzError, requireMembership } from "@/lib/authz";
import { generateBalanzaXml } from "@/lib/contabilidad/coe-xml";
import { prisma } from "@/lib/prisma";

// GET /api/contabilidad/coe/balanza?companyId=xxx&year=2026&month=3&tipo=N
// Returns the SAT COE Balanza de Comprobación XML for the period.
// SAT filename convention: RFC + YYYY + MM + "B" + tipoEnvio + ".XML"
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const companyId = url.searchParams.get("companyId");
    const year = parseInt(url.searchParams.get("year") ?? "");
    const month = parseInt(url.searchParams.get("month") ?? "");
    // tipo opcional: override manual N/C; si se omite, se decide automáticamente
    // (complementaria si la balanza cambió desde el último envío).
    const tipoParam = url.searchParams.get("tipo");
    const tipoOverride = tipoParam === "N" || tipoParam === "C" ? tipoParam : undefined;
    if (!companyId || !year || !month) {
      return NextResponse.json({ error: "companyId, year, month requeridos" }, { status: 400 });
    }

    await requireMembership(companyId);

    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { rfc: true },
    });
    if (!company) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

    const { xml, tipoEnvio } = await generateBalanzaXml({ companyId, year, month, tipoEnvio: tipoOverride });
    const filename = `${company.rfc}${year}${String(month).padStart(2, "0")}B${tipoEnvio}.XML`;

    return new NextResponse(xml, {
      status: 200,
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    const msg = e instanceof Error ? e.message : "Error generando XML";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
