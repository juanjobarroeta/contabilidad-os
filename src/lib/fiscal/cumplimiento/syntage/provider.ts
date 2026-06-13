// ─────────────────────────────────────────────────────────────────────────────
// SyntageComplianceProvider — implementa ComplianceProvider con la API de
// Syntage. Una extracción SAT trae varios documentos; aquí se piden los
// extractores tax_compliance (opinión) y tax_status (CSF) y se mapean a nuestros
// tipos. El mapeo companyId→entidad Syntage se inyecta (resolveEntity), para no
// acoplar este módulo a la base de datos.
// ─────────────────────────────────────────────────────────────────────────────

import type { ComplianceProvider } from "../provider";
import type { CsfResult, OpinionResult } from "../types";
import { SyntageClient, type Extractor } from "./client";
import { mapTaxCompliance, mapTaxStatus } from "./map";

/** Resuelve companyId → entidad Syntage (id) + RFC. Lo provee la capa de servicio. */
export type EntityResolver = (companyId: string) => Promise<{ entityId: string; rfc: string }>;

export interface SyntageProviderOpts {
  client?: SyntageClient;
  resolveEntity: EntityResolver;
}

export class SyntageComplianceProvider implements ComplianceProvider {
  private readonly client: SyntageClient;
  private readonly resolveEntity: EntityResolver;

  constructor(opts: SyntageProviderOpts) {
    this.client = opts.client ?? new SyntageClient();
    this.resolveEntity = opts.resolveEntity;
  }

  /** Corre la extracción (job) y espera a que termine; el dato vive aparte. */
  private async extraer(entityId: string, extractor: Extractor): Promise<void> {
    const { id } = await this.client.createExtraction({ extractor, entity: entityId });
    await this.client.waitForExtraction(id);
  }

  async fetchSatOpinion(companyId: string): Promise<OpinionResult> {
    const { entityId } = await this.resolveEntity(companyId);
    await this.extraer(entityId, "tax_compliance");
    const check = await this.client.getLatestTaxComplianceCheck(entityId);
    if (!check) {
      return { tipo: "SAT_OPINION", resultado: "ERROR", motivos: [], fetchedAt: new Date().toISOString() };
    }
    return mapTaxCompliance(check);
  }

  async fetchCsf(companyId: string): Promise<CsfResult> {
    const { entityId } = await this.resolveEntity(companyId);
    await this.extraer(entityId, "tax_status");
    const ts = await this.client.getLatestTaxStatus(entityId);
    if (!ts) {
      return { tipo: "CSF", perfil: { rfc: "", regimenes: [], obligaciones: [], estatusPadron: "DESCONOCIDO" }, fetchedAt: new Date().toISOString() };
    }
    return mapTaxStatus(ts);
  }

  /** Syntage no cubre IMSS; usar otro proveedor (p.ej. CS Facturación). */
  async fetchImssOpinion(): Promise<OpinionResult> {
    throw new Error("Syntage no provee la opinión de cumplimiento IMSS; usa otro proveedor.");
  }
}
