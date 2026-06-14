import { NextResponse } from "next/server";
import { AuthzError, requireMembership } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { generateAuxiliarFoliosXml } from "@/lib/contabilidad/coe-auxiliares";
import type { TipoSolicitud } from "@/lib/contabilidad/coe-polizas";

// GET /api/contabilidad/coe/aux-folios?companyId&year&month&tipoSolicitud&numOrden|numTramite
// Auxiliar de Folios (Anexo 24) — CFDIs por póliza, a solicitud del SAT.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const companyId = url.searchParams.get("companyId");
    const year = parseInt(url.searchParams.get("year") ?? "");
    const month = parseInt(url.searchParams.get("month") ?? "");
    const tipoSolicitud = url.searchParams.get("tipoSolicitud") as TipoSolicitud | null;
    const numOrden = url.searchParams.get("numOrden");
    const numTramite = url.searchParams.get("numTramite");
    if (!companyId || !year || !month) return NextResponse.json({ error: "companyId, year, month requeridos" }, { status: 400 });
    if (!tipoSolicitud || !["AF", "FC", "DE", "CO"].includes(tipoSolicitud)) {
      return NextResponse.json({ error: "tipoSolicitud requerido (AF|FC|DE|CO)" }, { status: 400 });
    }
    await requireMembership(companyId);
    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { rfc: true } });
    if (!company) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

    const xml = await generateAuxiliarFoliosXml({ companyId, year, month, tipoSolicitud, numOrden, numTramite });
    const filename = `${company.rfc}${year}${String(month).padStart(2, "0")}XF.XML`;
    return new NextResponse(xml, {
      status: 200,
      headers: { "Content-Type": "application/xml; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"` },
    });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error generando XML" }, { status: 500 });
  }
}
