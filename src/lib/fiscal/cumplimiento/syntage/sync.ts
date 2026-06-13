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
import { mapTaxCompliance, mapTaxStatus } from "./map";

export interface SyncResult {
  companyId: string;
  rfc?: string;
  opinion?: { changed: boolean; hallazgos: number } | null;
  csf?: { changed: boolean; hallazgos: number } | null;
  error?: string;
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

  return {
    companyId,
    rfc: company.rfc,
    opinion: opinion && { changed: opinion.changed, hallazgos: opinion.hallazgos },
    csf: csf && { changed: csf.changed, hallazgos: csf.hallazgos },
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
