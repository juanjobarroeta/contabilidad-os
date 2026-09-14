// ─────────────────────────────────────────────────────────────────────────────
// SatGoComplianceProvider — ComplianceProvider sobre SatGo. Hoy sólo la opinión
// IMSS (lo que Syntage no da). Opinión SAT y CSF siguen en Syntage hasta que
// se migren; aquí lanzan ComplianceProviderNoDisponible, no un resultado falso.
// El PDF se guarda entero como data URL en acuseUrl (≈1 MB): es el acuse.
// ─────────────────────────────────────────────────────────────────────────────

import { ComplianceProviderNoDisponible, type ComplianceProvider } from "../provider";
import type { CsfResult, OpinionResult } from "../types";
import { SatGoClient } from "./client";
import { interpretarOpinionImss } from "./imss";

export type RfcResolver = (companyId: string) => Promise<string>;

async function textoDePdf(pdf: Buffer): Promise<string> {
  // pdf-parse es CommonJS — igual que en obligaciones/csf.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require("pdf-parse");
  const data = await pdfParse(pdf);
  return String(data?.text ?? "");
}

export class SatGoComplianceProvider implements ComplianceProvider {
  private readonly client: SatGoClient;
  constructor(private readonly resolveRfc: RfcResolver, client?: SatGoClient) {
    this.client = client ?? new SatGoClient();
  }

  async fetchImssOpinion(companyId: string): Promise<OpinionResult> {
    const rfc = await this.resolveRfc(companyId);
    const { pdf, contentType } = await this.client.consultarImssOc(rfc);
    let texto = "";
    try { texto = await textoDePdf(pdf); } catch { /* ERROR con el PDF guardado */ }
    const acuseUrl = `data:${contentType};base64,${pdf.toString("base64")}`;
    return interpretarOpinionImss(texto, acuseUrl);
  }

  async fetchSatOpinion(): Promise<OpinionResult> { throw new ComplianceProviderNoDisponible("fetchSatOpinion"); }
  async fetchCsf(): Promise<CsfResult> { throw new ComplianceProviderNoDisponible("fetchCsf"); }
}
