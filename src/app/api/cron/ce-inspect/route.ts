import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { SyntageClient } from "@/lib/fiscal/cumplimiento/syntage/client";

// ─────────────────────────────────────────────────────────────────────────────
// GET/POST /api/cron/ce-inspect?companyId=<id>[&peek=1]
//
// Diagnóstico de SOLO LECTURA para la Contabilidad Electrónica vía Syntage.
// El arranque automático (`ceBootstrap` del compliance-sync) degrada en
// silencio: `importado:false` solo dice que no encontró nada importable, no
// DÓNDE se rompió la cadena. Este endpoint la desarma pieza por pieza:
//
//   • TODAS las entidades de Syntage que matchean el RFC (una empresa con más
//    de una entidad = las extracciones pueden vivir en la que NO resolvemos).
//   • Por entidad: cuántos electronic-accounting-records hay, histograma de
//     `fileType` (esperamos "CT"/"B"/"PL" — un histograma distinto delata un
//     mapeo desactualizado) y una muestra de metadatos con sus `files`.
//   • Con `peek=1`: descarga el primer archivo del registro más reciente y
//     devuelve los primeros bytes, para confirmar que el contenido es el XML
//     del SAT y no otra cosa.
//
// No escribe nada (ni en la BD ni en Syntage). Auth: CRON_SECRET.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Json = Record<string, unknown>;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}

function idDe(e: Json): string {
  if (e.id != null) return String(e.id);
  const iri = e["@id"];
  return typeof iri === "string" ? (iri.split("/").pop() ?? "") : "";
}

function filesMeta(rec: Json): Json[] {
  const files = Array.isArray(rec.files) ? (rec.files as Json[]) : [];
  return files.map((f) => ({
    type: f.type ?? null,
    mimeType: f.mimeType ?? null,
    ref: f["@id"] ?? f.id ?? null,
  }));
}

async function handle(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const params = new URL(req.url).searchParams;
  const companyId = params.get("companyId");
  const peek = params.get("peek") === "1";
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true, razonSocial: true, ceBootstrapAt: true },
  });
  if (!company) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

  try {
    const client = new SyntageClient();
    const target = company.rfc.trim().toUpperCase();
    // Mismo criterio laxo que findEntityByRfc, pero SIN quedarse con la
    // primera: aquí el punto es ver si hay más de una.
    const entidades = (await client.listEntities()).filter((e) =>
      JSON.stringify(e).toUpperCase().includes(target),
    );

    const reporte = [];
    for (const e of entidades) {
      const entityId = idDe(e);
      const [records, returns] = await Promise.all([
        client.getEntityElectronicAccounting(entityId),
        client.getEntityTaxReturns(entityId),
      ]);

      const porFileType: Record<string, number> = {};
      for (const r of records) {
        const t = String(r.fileType ?? "SIN_TIPO");
        porFileType[t] = (porFileType[t] ?? 0) + 1;
      }

      let muestraContenido: string | null = null;
      if (peek && records.length > 0) {
        const ref = filesMeta(records[0])[0]?.ref;
        if (ref) {
          try {
            muestraContenido = (await client.downloadFileText(String(ref))).slice(0, 400);
          } catch (err) {
            muestraContenido = `error al descargar: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      }

      reporte.push({
        entityId,
        name: e.name ?? null,
        createdAt: e.createdAt ?? null,
        taxReturns: returns.length,
        ceRecords: records.length,
        cePorFileType: porFileType,
        ceMuestra: records.slice(0, 3).map((r) => ({
          year: r.year ?? null,
          month: r.month ?? null,
          fileType: r.fileType ?? null,
          files: filesMeta(r),
        })),
        ...(muestraContenido != null ? { muestraContenido } : {}),
      });
    }

    return NextResponse.json({
      ok: true,
      companyId,
      rfc: company.rfc,
      razonSocial: company.razonSocial,
      ceBootstrapAt: company.ceBootstrapAt,
      entidadesEncontradas: reporte.length,
      entidades: reporte,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
