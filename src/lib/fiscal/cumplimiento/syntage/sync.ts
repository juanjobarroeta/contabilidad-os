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
import { mapTaxCompliance, mapTaxStatus, mapTaxReturnAnual } from "./map";

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
async function persistDeclaracionesAnuales(companyId: string, entityId: string, client: SyntageClient): Promise<number> {
  const returns = await client.getEntityTaxReturns(entityId);
  let creadas = 0;
  for (const tr of returns) {
    const anual = mapTaxReturnAnual(tr);
    if (!anual) continue;
    const periodo = String(anual.ejercicio);
    const existing = await prisma.taxDeclaration.findFirst({
      where: { companyId, tipo: "DECLARACION_ANUAL", periodo },
      select: { id: true },
    });
    if (existing) continue; // no sobreescribir lo capturado/calculado
    await prisma.taxDeclaration.create({
      data: {
        companyId,
        tipo: "DECLARACION_ANUAL",
        periodo,
        status: "FILED",
        isHistorical: true,
        isrPagar: anual.isrPagar,
        lineaCaptura: anual.lineaCaptura ?? null,
        fechaPresentacion: anual.fechaPresentacion ? new Date(anual.fechaPresentacion) : null,
      },
    });
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
