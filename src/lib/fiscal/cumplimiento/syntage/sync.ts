// ─────────────────────────────────────────────────────────────────────────────
// Sincronización de cumplimiento desde Syntage (modo LECTURA): trae los últimos
// resultados ya extraídos (tax-compliance-check / tax-status) de la entidad y
// los persiste. Rápido (solo GETs) — no corre extracción, así que no choca con
// el timeout del proxy. La frescura la dan los schedulers de Syntage (o un kick
// aparte). El companyId→entidad se resuelve por RFC.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { persistComplianceResult } from "../persist";
import { SyntageClient } from "./client";
import { mapTaxCompliance, mapTaxStatus, mapTaxReturnAnual, camposAnualDesdeAcuse } from "./map";
import { fileRefDe } from "./declaraciones-backfill";
import { parseSatDocument } from "@/lib/fiscal/acuse/parse";

export interface SyncResult {
  companyId: string;
  rfc?: string;
  opinion?: { changed: boolean; hallazgos: number } | null;
  csf?: { changed: boolean; hallazgos: number } | null;
  /** Declaraciones anuales históricas creadas a partir de los tax-returns. */
  declaracionesAnuales?: { creadas: number } | null;
  error?: string;
}

/**
 * Persiste las declaraciones ANUALES extraídas (tax-returns con intervalUnit
 * "Anual") como TaxDeclaration históricas, cerrando los faltantes de años
 * cerrados en /declaraciones. Sólo RELLENA huecos: si ya existe una anual para
 * ese ejercicio (capturada o calculada), no la toca. Devuelve cuántas creó.
 *
 * Las mensuales no se importan aquí: el recurso de Syntage trae un único
 * `payment` agregado (sin separar IVA/ISR) y nuestro modelo sí los separa con
 * importes propios; crear filas mensuales sin importe ocultaría la captura real
 * (subvaluando el arrastre de pagos provisionales).
 */
/**
 * Parsea el acuse ANUAL (PDF) con Claude y rellena en la DECLARACION_ANUAL las
 * columnas del coeficiente de utilidad (ingresos nominales ÷ utilidad fiscal) y
 * el remanente de pérdidas pendiente —que el motor usa como respaldo del valor
 * manual de la empresa (computeTaxPosition)—. Best-effort y gap-fill: se llama
 * sólo cuando esas columnas están vacías, así cada anual se parsea una vez (no
 * en cada corrida del sync). No toca el campo manual de la empresa.
 */
async function enriquecerAnualDesdePdf(declId: string, companyId: string, pdf: Uint8Array): Promise<void> {
  let parsed;
  try {
    parsed = await parseSatDocument(Buffer.from(pdf).toString("base64"), {
      companyId,
      subtipo: "declaraciones.anual.coeficiente",
    });
  } catch {
    return; // si Claude falla, no rompemos el sync; se reintenta la próxima corrida
  }
  if (parsed.type !== "ACUSE_ANUAL" || !parsed.acuseAnual) return;
  const c = camposAnualDesdeAcuse(parsed.acuseAnual);
  if (c.isrIngresos == null && c.isrBaseGravable == null && c.isrCoeficienteUtilidad == null && c.isrPerdidaPendiente == null) {
    return; // nada aprovechable extraído
  }
  await prisma.taxDeclaration.update({
    where: { id: declId },
    data: {
      isrIngresos: c.isrIngresos,
      isrBaseGravable: c.isrBaseGravable,
      isrCoeficienteUtilidad: c.isrCoeficienteUtilidad,
      isrPerdidaPendiente: c.isrPerdidaPendiente,
    },
  });
}

async function persistDeclaracionesAnuales(companyId: string, entityId: string, client: SyntageClient): Promise<number> {
  const returns = await client.getEntityTaxReturns(entityId);
  let creadas = 0;
  for (const tr of returns) {
    const anual = mapTaxReturnAnual(tr);
    if (!anual) continue;
    const periodo = String(anual.ejercicio);
    const existing = await prisma.taxDeclaration.findFirst({
      where: { companyId, tipo: "DECLARACION_ANUAL", periodo },
      select: { id: true, isrIngresos: true, isrCoeficienteUtilidad: true, isrPerdidaPendiente: true, acusePdf: true },
    });

    if (existing) {
      // Gap-fill: si la anual ya existe pero aún no se le extrajo el coeficiente
      // ni la pérdida (y tenemos el PDF), parsearla una sola vez. No sobreescribe
      // importes capturados/calculados.
      const sinEnriquecer =
        existing.isrIngresos == null && existing.isrCoeficienteUtilidad == null && existing.isrPerdidaPendiente == null;
      if (sinEnriquecer && existing.acusePdf) {
        await enriquecerAnualDesdePdf(existing.id, companyId, new Uint8Array(existing.acusePdf));
      }
      continue;
    }

    // Acuse PDF (sólo al crear, para que sea descargable). Best-effort.
    let acusePdf: Uint8Array<ArrayBuffer> | null = null;
    const ref = fileRefDe(tr as Record<string, unknown>);
    if (ref) {
      try {
        acusePdf = new Uint8Array((await client.downloadAcuse(ref)).data);
      } catch {
        acusePdf = null;
      }
    }

    const creada = await prisma.taxDeclaration.create({
      data: {
        companyId,
        tipo: "DECLARACION_ANUAL",
        periodo,
        status: "FILED",
        isHistorical: true,
        isrPagar: anual.isrPagar,
        lineaCaptura: anual.lineaCaptura ?? null,
        fechaPresentacion: anual.fechaPresentacion ? new Date(anual.fechaPresentacion) : null,
        ...(acusePdf ? { acusePdf, acusePdfNombre: `acuse-anual-${periodo}.pdf` } : {}),
      },
      select: { id: true },
    });
    if (acusePdf) await enriquecerAnualDesdePdf(creada.id, companyId, acusePdf);
    creadas++;
  }
  return creadas;
}

export async function syncCompanyComplianceSyntage(
  companyId: string,
  client = new SyntageClient(),
): Promise<SyncResult> {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { rfc: true } });
  if (!company) return { companyId, error: "Empresa no encontrada" };

  const entity = await client.findEntityByRfc(company.rfc);
  if (!entity) return { companyId, rfc: company.rfc, error: "Sin entidad en Syntage para ese RFC" };

  const [opRaw, csfRaw] = await Promise.all([
    client.getLatestTaxComplianceCheck(entity.id),
    client.getLatestTaxStatus(entity.id),
  ]);

  const opinion = opRaw
    ? await persistComplianceResult(companyId, mapTaxCompliance(opRaw))
    : null;
  const csf = csfRaw ? await persistComplianceResult(companyId, mapTaxStatus(csfRaw)) : null;

  // Declaraciones anuales: aislado en try/catch para no romper opinión/CSF si
  // los tax-returns aún no se han extraído o el recurso cambia de forma.
  let declaracionesAnuales: { creadas: number } | null = null;
  try {
    declaracionesAnuales = { creadas: await persistDeclaracionesAnuales(companyId, entity.id, client) };
  } catch {
    declaracionesAnuales = null;
  }

  return {
    companyId,
    rfc: company.rfc,
    opinion: opinion && { changed: opinion.changed, hallazgos: opinion.hallazgos },
    csf: csf && { changed: csf.changed, hallazgos: csf.hallazgos },
    declaracionesAnuales,
  };
}

/** Sincroniza todas las empresas (una sola instancia de cliente). */
export async function syncAllCompaniesComplianceSyntage(): Promise<{
  empresas: number;
  errores: number;
  resultados: SyncResult[];
}> {
  const client = new SyntageClient();
  const companies = await prisma.company.findMany({ select: { id: true } });
  const resultados: SyncResult[] = [];
  let errores = 0;
  for (const c of companies) {
    try {
      const r = await syncCompanyComplianceSyntage(c.id, client);
      if (r.error) errores++;
      resultados.push(r);
    } catch (e) {
      errores++;
      resultados.push({ companyId: c.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { empresas: companies.length, errores, resultados };
}
