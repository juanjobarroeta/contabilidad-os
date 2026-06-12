// ─────────────────────────────────────────────────────────────────────────────
// Sector profile — derives a company's actividades (Sector[]) from its SAT
// régimen and its actividadEconomica (SCIAN free-text description).
//
// Best-effort and contador-overridable: régimen codes give strong signals (622
// AGAPES, 624 Coordinados/autotransporte, 606 arrendamiento, 625 plataformas);
// the SCIAN text fills the rest by keyword. When a UI override exists, prefer it
// over this inference.
// ─────────────────────────────────────────────────────────────────────────────

import type { Contexto, Entidad, Sector, TipoPersona } from "./types";

// CP prefix (first 2 digits) → entidad federativa. Best-effort SEPOMEX ranges;
// boundary códigos may be off, so this is overridable. Source of truth for a
// company should be its domicilio fiscal when a contador confirms it.
const CP_ENTIDAD: { desde: number; hasta: number; entidad: Entidad }[] = [
  { desde: 0, hasta: 16, entidad: "CMX" },
  { desde: 20, hasta: 20, entidad: "AGU" },
  { desde: 21, hasta: 22, entidad: "BCN" },
  { desde: 23, hasta: 23, entidad: "BCS" },
  { desde: 24, hasta: 24, entidad: "CAM" },
  { desde: 25, hasta: 27, entidad: "COA" },
  { desde: 28, hasta: 28, entidad: "COL" },
  { desde: 29, hasta: 30, entidad: "CHP" },
  { desde: 31, hasta: 33, entidad: "CHH" },
  { desde: 34, hasta: 35, entidad: "DUR" },
  { desde: 36, hasta: 38, entidad: "GUA" },
  { desde: 39, hasta: 41, entidad: "GRO" },
  { desde: 42, hasta: 43, entidad: "HID" },
  { desde: 44, hasta: 49, entidad: "JAL" },
  { desde: 50, hasta: 57, entidad: "MEX" },
  { desde: 58, hasta: 61, entidad: "MIC" },
  { desde: 62, hasta: 62, entidad: "MOR" },
  { desde: 63, hasta: 63, entidad: "NAY" },
  { desde: 64, hasta: 67, entidad: "NLE" },
  { desde: 68, hasta: 71, entidad: "OAX" },
  { desde: 72, hasta: 75, entidad: "PUE" },
  { desde: 76, hasta: 76, entidad: "QUE" },
  { desde: 77, hasta: 77, entidad: "ROO" },
  { desde: 78, hasta: 79, entidad: "SLP" },
  { desde: 80, hasta: 82, entidad: "SIN" },
  { desde: 83, hasta: 85, entidad: "SON" },
  { desde: 86, hasta: 86, entidad: "TAB" },
  { desde: 87, hasta: 89, entidad: "TAM" },
  { desde: 90, hasta: 90, entidad: "TLA" },
  { desde: 91, hasta: 96, entidad: "VER" },
  { desde: 97, hasta: 97, entidad: "YUC" },
  { desde: 98, hasta: 99, entidad: "ZAC" },
];

/** Best-effort entidad from a 5-digit código postal; undefined if unknown. */
export function estadoDesdeCP(cp?: string | null): Entidad | undefined {
  if (!cp) return undefined;
  const limpio = cp.trim();
  if (!/^\d{4,5}$/.test(limpio)) return undefined;
  const prefijo = parseInt(limpio.padStart(5, "0").slice(0, 2), 10);
  return CP_ENTIDAD.find((r) => prefijo >= r.desde && prefijo <= r.hasta)?.entidad;
}

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
  codigoPostal?: string | null;
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
 * Build the Contexto a rule is resolved against. Overrides let a UI/contador
 * classification take precedence over inference.
 */
export function construirContexto(
  company: CompanyLike,
  fecha: string,
  overrides?: { actividades?: Sector[]; entidad?: Entidad },
): Contexto {
  return {
    regimen: company.regimenFiscal.trim(),
    actividades: overrides?.actividades ?? inferSectores(company),
    tipoPersona: inferTipoPersona(company.rfc),
    entidad: overrides?.entidad ?? estadoDesdeCP(company.codigoPostal),
    fecha,
  };
}
