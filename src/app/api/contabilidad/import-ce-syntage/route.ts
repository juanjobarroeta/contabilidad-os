import { NextResponse } from "next/server";
import { AuthzError, requireWriter } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { AperturaError } from "@/lib/contabilidad/apertura";
import { importarContabilidadElectronicaSyntage } from "@/lib/contabilidad/ce-import-syntage";

export const runtime = "nodejs";
export const maxDuration = 60;

// POST /api/contabilidad/import-ce-syntage   (application/json)
//   body: { companyId: string (requerido),
//           from?: "YYYY-MM-DD",  // inicio del periodo a extraer
//           to?:   "YYYY-MM-DD" } // fin del periodo a extraer
//
// Arranca la contabilidad "real" trayendo la Contabilidad Electrónica (Anexo 24)
// AUTOMÁTICAMENTE desde Syntage (extractor `electronic_accounting`): catálogo de
// cuentas + última balanza de comprobación. Reutiliza importarCatalogo /
// importarBalanza (idempotentes; postApertura no toca asientos CFDI/NOMINA/BANCO/
// MANUAL). Es la alternativa al alta manual de XML (/api/contabilidad/import-ce).
// Gateado por plan (AUTOMATIZADO+) y medido como CostEvent.
export async function POST(req: Request) {
  try {
    let companyId = "";
    let from = "";
    let to = "";
    try {
      const body = (await req.json()) as { companyId?: string; from?: string; to?: string };
      companyId = String(body.companyId ?? "").trim();
      from = String(body.from ?? "").trim();
      to = String(body.to ?? "").trim();
    } catch {
      return NextResponse.json({ error: "Espera JSON con 'companyId'." }, { status: 400 });
    }

    if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

    await requireWriter(companyId, req);

    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
    if (!company) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

    // Periodo por defecto: últimos 13 meses (suficiente para traer el último
    // catálogo y la última balanza presentada). El SAT recibe la CE mensual.
    const periodo = rangoPeriodo(from, to);

    const res = await importarContabilidadElectronicaSyntage(companyId, periodo);
    if (res.error) {
      return NextResponse.json({ error: res.error }, { status: 502 });
    }
    if (res.skipped) {
      return NextResponse.json(
        { error: "El plan de la empresa no incluye Syntage. Usa la subida manual de XML." },
        { status: 409 },
      );
    }
    if (!res.catalogo && !res.balanza) {
      return NextResponse.json(
        {
          ok: false,
          extraccionDisparada: res.extraccionDisparada,
          error:
            "Syntage aún no tiene los XML de Contabilidad Electrónica de esta empresa. La extracción se disparó; reintenta en unos minutos o usa la subida manual.",
        },
        { status: 202 },
      );
    }

    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof AperturaError) {
      return NextResponse.json({ error: e.message, diferencia: e.diferencia }, { status: 400 });
    }
    throw e;
  }
}

/** Ventana ISO a partir de from/to (YYYY-MM-DD); por defecto últimos 13 meses. */
function rangoPeriodo(from: string, to: string): { from: string; to: string } {
  const reFecha = /^\d{4}-\d{2}-\d{2}$/;
  const now = new Date();
  const desde = reFecha.test(from)
    ? `${from}T00:00:00.000Z`
    : new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth() - 1, 1)).toISOString();
  const hasta = reFecha.test(to) ? `${to}T23:59:59.000Z` : now.toISOString();
  return { from: desde, to: hasta };
}
