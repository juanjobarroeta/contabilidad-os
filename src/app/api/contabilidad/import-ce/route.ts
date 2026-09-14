import { NextResponse } from "next/server";
import { AuthzError, requireWriter } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { AperturaError } from "@/lib/contabilidad/apertura";
import { importarCatalogo, importarBalanza, importarBalanzaParsed, importarCuentasCatalogo } from "@/lib/contabilidad/ce-import-apply";
import { parseBalanzaTabular, parseCatalogoTabular } from "@/lib/contabilidad/catalogo-tabular";

/** CSV/Excel se leen como tabla; todo lo demás se trata como XML del Anexo 24. */
function esTabular(f: File): boolean {
  return /\.(csv|xlsx|xlsm|xls|txt)$/i.test(f.name) || /spreadsheet|ms-excel|text\/csv/i.test(f.type);
}

export const runtime = "nodejs";
export const maxDuration = 60;

// POST /api/contabilidad/import-ce  (multipart/form-data)
//   campos: companyId (requerido)
//           catalogo  (Catálogo de Cuentas: XML del Anexo 24, o CSV/Excel de
//                      CONTPAQi / Aspel COI / hoja del contador — opcional)
//           balanza   (Balanza de Comprobación: XML, CSV o Excel — opcional)
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
    let catalogoTabla: Uint8Array | null = null;
    let balanzaTabla: Uint8Array | null = null;
    let usar: "inicial" | "final" = "final";
    let fecha: string | undefined;

    try {
      const fd = await req.formData();
      companyId = String(fd.get("companyId") ?? "");
      const cat = fd.get("catalogo");
      const bal = fd.get("balanza");
      if (cat instanceof File) {
        if (esTabular(cat)) catalogoTabla = new Uint8Array(await cat.arrayBuffer());
        else catalogoXml = await cat.text();
      }
      if (bal instanceof File) {
        if (esTabular(bal)) balanzaTabla = new Uint8Array(await bal.arrayBuffer());
        else balanzaXml = await bal.text();
      }
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
    if (!catalogoXml && !balanzaXml && !catalogoTabla && !balanzaTabla) {
      return NextResponse.json({ error: "Sube el catálogo y/o la balanza (XML del SAT, o CSV/Excel de tu sistema)." }, { status: 400 });
    }

    await requireWriter(companyId, req);

    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
    if (!company) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

    const advertencias: string[] = [];

    // 1) Catálogo primero (la balanza necesita el catálogo para resolver naturalezas).
    let catalogo: Awaited<ReturnType<typeof importarCatalogo>> | null = null;
    if (catalogoTabla) {
      const t = parseCatalogoTabular(catalogoTabla);
      advertencias.push(...t.advertencias);
      if (t.cuentas.length === 0) {
        return NextResponse.json({ error: `No pude leer cuentas del archivo. ${t.advertencias[0] ?? ""}`.trim(), advertencias }, { status: 400 });
      }
      catalogo = await importarCuentasCatalogo(companyId, t.cuentas);
    } else if (catalogoXml) {
      catalogo = await importarCatalogo(companyId, catalogoXml);
    }

    // 2) Balanza → saldos de apertura.
    let balanza: Awaited<ReturnType<typeof importarBalanza>> | null = null;
    if (balanzaTabla) {
      const t = parseBalanzaTabular(balanzaTabla);
      advertencias.push(...t.advertencias);
      if (t.cuentas.length === 0) {
        return NextResponse.json({ error: `No pude leer la balanza del archivo. ${t.advertencias[0] ?? ""}`.trim(), advertencias }, { status: 400 });
      }
      balanza = await importarBalanzaParsed(companyId, t, { usar, fechaISO: fecha });
    } else if (balanzaXml) {
      balanza = await importarBalanza(companyId, balanzaXml, { usar, fechaISO: fecha });
    }

    return NextResponse.json({ ok: true, catalogo, balanza, advertencias });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof AperturaError) {
      return NextResponse.json({ error: e.message, diferencia: e.diferencia }, { status: 400 });
    }
    throw e;
  }
}
