// ─────────────────────────────────────────────────────────────────────────────
// Sector profile — derives a company's actividades (Sector[]) from its SAT
// régimen and its actividadEconomica (SCIAN free-text description).
//
// Best-effort and contador-overridable: régimen codes give strong signals (622
// AGAPES, 624 Coordinados/autotransporte, 606 arrendamiento, 625 plataformas);
// the SCIAN text fills the rest by keyword. When a UI override exists, prefer it
// over this inference.
// ─────────────────────────────────────────────────────────────────────────────

import type { Contexto, Sector, TipoPersona } from "./types";

/** SAT régimen → sector, when the régimen itself implies an activity. */
const REGIMEN_SECTOR: Record<string, Sector> = {
  "606": "ARRENDAMIENTO", // Arrendamiento
  "622": "AGAPES", // Actividades Agrícolas, Ganaderas, Silvícolas y Pesqueras
  "624": "AUTOTRANSPORTE", // Coordinados
  "625": "PLATAFORMAS", // Actividades empresariales vía plataformas tecnológicas
};

/** Keyword → sector over the actividadEconomica (SCIAN) description. */
const KEYWORD_SECTOR: { sector: Sector; palabras: string[] }[] = [
  { sector: "CONSTRUCCION", palabras: ["construc", "obra", "inmobili", "edificaci", "vivienda"] },
  {
    sector: "AUTOTRANSPORTE",
    palabras: ["autotransporte", "transporte de carga", "fletes", "mudanz", "pasaje"],
  },
  { sector: "JOYERIA", palabras: ["joyer", "joyas", "metales preciosos", "orfebr", "relojes"] },
  {
    sector: "RESTAURANTES",
    palabras: ["restaurant", "cafeter", "alimentos", "comida", "cater", "bar "],
  },
  {
    sector: "AGAPES",
    palabras: ["agrícol", "agricola", "ganader", "silvícol", "silvicol", "pesc", "cultivo", "cosecha"],
  },
  { sector: "EXPORTACION", palabras: ["exportaci", "export "] },
  { sector: "INDUSTRIA", palabras: ["industri", "manufactur", "fabricaci", "producci", "planta"] },
];

/** PM RFC is 12 chars, PF is 13. Falls back to PF if malformed. */
export function inferTipoPersona(rfc: string): TipoPersona {
  return rfc.trim().length === 12 ? "PM" : "PF";
}

export interface CompanyLike {
  rfc: string;
  regimenFiscal: string;
  actividadEconomica?: string | null;
}

/** Derived sectors for a company (deduped, order-stable). */
export function inferSectores(company: CompanyLike): Sector[] {
  const out = new Set<Sector>();

  const porRegimen = REGIMEN_SECTOR[company.regimenFiscal.trim()];
  if (porRegimen) out.add(porRegimen);

  const texto = (company.actividadEconomica ?? "").toLowerCase();
  if (texto) {
    for (const { sector, palabras } of KEYWORD_SECTOR) {
      if (palabras.some((p) => texto.includes(p))) out.add(sector);
    }
  }
  return [...out];
}

/**
 * Build the Contexto a rule is resolved against. `actividadesOverride` lets a
 * UI/contador classification take precedence over inference.
 */
export function construirContexto(
  company: CompanyLike,
  fecha: string,
  actividadesOverride?: Sector[],
): Contexto {
  return {
    regimen: company.regimenFiscal.trim(),
    actividades: actividadesOverride ?? inferSectores(company),
    tipoPersona: inferTipoPersona(company.rfc),
    fecha,
  };
}
