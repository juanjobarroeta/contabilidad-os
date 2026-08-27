import { NextResponse } from "next/server";
import { AuthzError, requireMembership } from "@/lib/authz";
import { generateCatalogoXml } from "@/lib/contabilidad/coe-xml";
import { prisma } from "@/lib/prisma";
import { validarCatalogoXml } from "@/lib/contabilidad/coe-validador";

// GET /api/contabilidad/coe/catalogo?companyId=xxx&year=2026&month=3
// Returns the SAT COE Catálogo de Cuentas XML for the period.
// Content-Type is application/xml and content-disposition prompts a download
// with the SAT-standard filename: RFC + YYYY + MM + "CT.XML"
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

    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { rfc: true },
    });
    if (!company) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

    const xml = await generateCatalogoXml({ companyId, year, month });
    // Fail-closed: un CodAgrup fuera de la enum del SAT rebota el archivo —
    // mejor 422 con el detalle aquí que un rechazo del SAT después.
    const val = validarCatalogoXml(xml);
    if (!val.ok) {
      return NextResponse.json(
        { error: "El catálogo no pasaría la validación del SAT", detalles: val.errores },
        { status: 422 },
      );
    }
    const filename = `${company.rfc}${year}${String(month).padStart(2, "0")}CT.XML`;

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
