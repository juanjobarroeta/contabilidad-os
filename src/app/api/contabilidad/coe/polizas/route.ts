import { NextResponse } from "next/server";
import { AuthzError, requireMembership } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { generatePolizasXmlDetallado, type TipoSolicitud } from "@/lib/contabilidad/coe-polizas";
import { validarPolizasXml } from "@/lib/contabilidad/coe-validador";

// GET /api/contabilidad/coe/polizas?companyId&year&month&tipoSolicitud=DE&numTramite=AB123456789012
// Pólizas del Periodo (Anexo 24) — se entrega a solicitud del SAT.
//   tipoSolicitud: AF | FC (auditoría → NumOrden) · DE | CO (devolución/comp. → NumTramite)
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const companyId = url.searchParams.get("companyId");
    const year = parseInt(url.searchParams.get("year") ?? "");
    const month = parseInt(url.searchParams.get("month") ?? "");
    const tipoSolicitud = url.searchParams.get("tipoSolicitud") as TipoSolicitud | null;
    const numOrden = url.searchParams.get("numOrden");
    const numTramite = url.searchParams.get("numTramite");
    if (!companyId || !year || !month) {
      return NextResponse.json({ error: "companyId, year, month requeridos" }, { status: 400 });
    }
    if (!tipoSolicitud || !["AF", "FC", "DE", "CO"].includes(tipoSolicitud)) {
      return NextResponse.json({ error: "tipoSolicitud requerido (AF|FC|DE|CO)" }, { status: 400 });
    }

    await requireMembership(companyId);

    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { rfc: true } });
    if (!company) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

    const { xml, bancarias, sinEvidencia } = await generatePolizasXmlDetallado({
      companyId, year, month, tipoSolicitud, numOrden, numTramite,
    });
    const val = validarPolizasXml(xml);
    if (!val.ok) {
      return NextResponse.json(
        { error: "Las pólizas no pasarían la validación del SAT", detalles: val.errores },
        { status: 422 },
      );
    }
    const filename = `${company.rfc}${year}${String(month).padStart(2, "0")}PL.XML`;

    return new NextResponse(xml, {
      status: 200,
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        // Diagnóstico visible: pólizas bancarias sin nodo Transferencia (banco
        // no resoluble con datos reales). El panel lo muestra; no bloquea.
        "X-Polizas-Bancarias": String(bancarias),
        "X-Polizas-Sin-Evidencia": String(sinEvidencia),
      },
    });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error generando XML" }, { status: 500 });
  }
}
