import { NextResponse } from "next/server";
import { AuthzError, requireWriter } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { AperturaError } from "@/lib/contabilidad/apertura";
import { importarCatalogo, importarBalanza } from "@/lib/contabilidad/ce-import-apply";

export const runtime = "nodejs";
export const maxDuration = 60;

// POST /api/contabilidad/import-ce  (multipart/form-data)
//   campos: companyId (requerido)
//           catalogo  (XML del Catálogo de Cuentas — opcional)
//           balanza   (XML de la Balanza de Comprobación — opcional)
//           usar      ("inicial" | "final"; default "final") base de los saldos
//           fecha     ("YYYY-MM-DD"; opcional) fecha del asiento de apertura
//
// Arranca la contabilidad "real" a partir de la Contabilidad Electrónica (Anexo
// 24): el catálogo bootstrapea el chart of accounts (upsert, sin duplicar) y la
// balanza crea los saldos iniciales (asiento de apertura, fuente=APERTURA, vía
// postApertura — idempotente, no toca asientos CFDI/NOMINA/BANCO/MANUAL).
//
// Nota: ésta es la ruta de SUBIDA MANUAL (fallback). El auto-fetch desde Syntage
// (extractor `electronic_accounting`) vive en /api/contabilidad/import-ce-syntage
// y reutiliza los mismos importadores (importarCatalogo / importarBalanza).
export async function POST(req: Request) {
  try {
    let companyId = "";
    let catalogoXml: string | null = null;
    let balanzaXml: string | null = null;
    let usar: "inicial" | "final" = "final";
    let fecha: string | undefined;

    try {
      const fd = await req.formData();
      companyId = String(fd.get("companyId") ?? "");
      const cat = fd.get("catalogo");
      const bal = fd.get("balanza");
      if (cat instanceof File) catalogoXml = await cat.text();
      if (bal instanceof File) balanzaXml = await bal.text();
      const usarRaw = String(fd.get("usar") ?? "");
      if (usarRaw === "inicial" || usarRaw === "final") usar = usarRaw;
      const fechaRaw = String(fd.get("fecha") ?? "").trim();
      if (fechaRaw) fecha = fechaRaw;
    } catch {
      return NextResponse.json(
        { error: "Espera multipart/form-data con 'companyId' y al menos uno de 'catalogo'/'balanza'." },
        { status: 400 },
      );
    }

    if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
    if (!catalogoXml && !balanzaXml) {
      return NextResponse.json({ error: "Sube el XML del catálogo y/o de la balanza." }, { status: 400 });
    }

    await requireWriter(companyId, req);

    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
    if (!company) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

    // 1) Catálogo primero (la balanza necesita el catálogo para resolver naturalezas).
    const catalogo = catalogoXml ? await importarCatalogo(companyId, catalogoXml) : null;

    // 2) Balanza → saldos de apertura.
    let balanza: Awaited<ReturnType<typeof importarBalanza>> | null = null;
    if (balanzaXml) {
      balanza = await importarBalanza(companyId, balanzaXml, { usar, fechaISO: fecha });
    }

    return NextResponse.json({ ok: true, catalogo, balanza });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof AperturaError) {
      return NextResponse.json({ error: e.message, diferencia: e.diferencia }, { status: 400 });
    }
    throw e;
  }
}
