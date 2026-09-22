// ─────────────────────────────────────────────────────────────────────────────
// SatGoComplianceProvider — ComplianceProvider sobre SatGo, completo:
//   • Opinión SAT 32-D  → POST ocfiel  (e.firma)  → PDF → interpretarOpinionSat
//   • CSF               → POST csffiel (e.firma)  → PDF → csfDesdePdf (Claude)
//   • Opinión IMSS      → GET  imssoc  (sólo RFC) → PDF → interpretarOpinionImss
// Cada resultado lleva los BYTES del PDF (acusePdf): persistComplianceResult
// los guarda en la base. Es el reemplazo de SyntageComplianceProvider con una
// sola credencial — la e.firma que ya guardamos — sin CIEC ni captcha.
// ─────────────────────────────────────────────────────────────────────────────

import { ComplianceProviderNoDisponible, type ComplianceProvider } from "../provider";
import type { CsfResult, OpinionResult } from "../types";
import { nombreAcuse } from "../persist";
import { textoDePdf } from "../../fuentes/texto";
import { SatGoClient } from "./client";
import { fielDeEmpresa, type FielResolver } from "./fiel";
import { interpretarOpinionImss } from "./imss";
import { interpretarOpinionSat } from "./sat-opinion";
import { csfDesdePdf } from "./csf";

export type RfcResolver = (companyId: string) => Promise<string>;

export class SatGoComplianceProvider implements ComplianceProvider {
  private readonly client: SatGoClient;
  private readonly resolveFiel: FielResolver;

  /**
   * `resolveRfc` basta para la opinión IMSS; `resolveFiel` (default: la e.firma
   * guardada de la empresa) hace falta para 32-D y CSF.
   */
  constructor(private readonly resolveRfc: RfcResolver, client?: SatGoClient, resolveFiel: FielResolver = fielDeEmpresa) {
    this.client = client ?? new SatGoClient();
    this.resolveFiel = resolveFiel;
  }

  async fetchImssOpinion(companyId: string): Promise<OpinionResult> {
    const rfc = await this.resolveRfc(companyId);
    const { pdf } = await this.client.consultarImssOc(rfc);
    let texto = "";
    try { texto = await textoDePdf(pdf); } catch { /* ERROR con el PDF guardado */ }
    const ahora = new Date();
    return { ...interpretarOpinionImss(texto, undefined, ahora), acusePdf: pdf, acusePdfNombre: nombreAcuse("IMSS_OPINION", ahora) };
  }

  async fetchSatOpinion(companyId: string): Promise<OpinionResult> {
    const fiel = await this.resolveFiel(companyId);
    const { data } = await this.client.consultarOcFiel(fiel);
    let texto = "";
    try { texto = await textoDePdf(data); } catch { /* ERROR con el PDF guardado */ }
    const ahora = new Date();
    return { ...interpretarOpinionSat(texto, ahora), acusePdf: data, acusePdfNombre: nombreAcuse("SAT_OPINION", ahora) };
  }

  async fetchCsf(companyId: string): Promise<CsfResult> {
    const fiel = await this.resolveFiel(companyId);
    const { data } = await this.client.consultarCsfFiel(fiel);
    const { perfil } = await csfDesdePdf(data, fiel.rfc, { companyId, subtipo: "cumplimiento.csf.satgo" });
    const ahora = new Date();
    return { tipo: "CSF", perfil, acusePdf: data, acusePdfNombre: nombreAcuse("CSF", ahora), fetchedAt: ahora.toISOString() };
  }
}

export { ComplianceProviderNoDisponible };
