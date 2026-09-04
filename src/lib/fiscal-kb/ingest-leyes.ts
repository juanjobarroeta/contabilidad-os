// Fetch + parse leyes vigentes from the Cámara de Diputados (official texto
// vigente PDFs, public domain). Extracts the "Última reforma publicada DOF"
// date as the version's vigencia/publication marker.
//
// Phase-0 caveat (documented in docs/FISCAL-KNOWLEDGE-BASE.md §4): we use the
// DOF publication date of the latest reform as `vigenciaDesde`. Strictly,
// entry into force is governed by each decreto's transitorios — good enough
// to version texts; refine in Phase 2.

export interface LeyDescriptor {
  clave: string;
  titulo: string;
  url: string;
  /** LEY (default) o REGLAMENTO — decide la cita: «Art. 3 RLIVA». */
  source?: "LEY" | "REGLAMENTO";
  /**
   * Vigencia de respaldo (YYYY-MM-DD) para una fuente cuyo encabezado NO trae
   * «Última reforma DOF» — un texto que nunca ha sido reformado sólo dice
   * «Nuevo Reglamento publicado en el DOF el …». Se usa únicamente cuando el
   * encabezado no da fecha; si algún día lo reforman, la del encabezado gana.
   */
  vigenciaFallback?: string;
}

/**
 * Catálogo de leyes y reglamentos — texto vigente, Cámara de Diputados.
 *
 * Fase 1 del plan del copiloto («alimentar con lo que se usa a diario»): los
 * reglamentos son donde viven las respuestas que un contador da a diario y
 * que la ley sola no contesta — RLIVA 3 (retención de 2/3 del IVA), RLISR 3-A
 * (la pickup no es «automóvil»), RCFF (avisos, plazos). Y las leyes de nómina
 * (LSS, LINFONAVIT, LFT) para todo lo que el patrón pregunta.
 *
 * Todas se refrescan solas (workflow fiscal-kb-refresh, ingesta idempotente
 * por hash). Los nombres de archivo de los reglamentos llevan fecha
 * (Reg_LISR_060516) — si Diputados los renombra, el refresco falla en voz
 * alta y se corrige aquí.
 */
export const LEYES: Record<string, LeyDescriptor> = {
  LISR: {
    clave: "LISR",
    titulo: "Ley del Impuesto sobre la Renta",
    url: "https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf",
  },
  LIVA: {
    clave: "LIVA",
    titulo: "Ley del Impuesto al Valor Agregado",
    url: "https://www.diputados.gob.mx/LeyesBiblio/pdf/LIVA.pdf",
  },
  CFF: {
    clave: "CFF",
    titulo: "Código Fiscal de la Federación",
    url: "https://www.diputados.gob.mx/LeyesBiblio/pdf/CFF.pdf",
  },
  LIEPS: {
    clave: "LIEPS",
    titulo: "Ley del Impuesto Especial sobre Producción y Servicios",
    url: "https://www.diputados.gob.mx/LeyesBiblio/pdf/LIEPS.pdf",
  },
  // ── Reglamentos ──────────────────────────────────────────────────────────────
  RLISR: {
    clave: "RLISR",
    titulo: "Reglamento de la Ley del Impuesto sobre la Renta",
    url: "https://www.diputados.gob.mx/LeyesBiblio/regley/Reg_LISR_060516.pdf",
    source: "REGLAMENTO",
  },
  RLIVA: {
    clave: "RLIVA",
    titulo: "Reglamento de la Ley del Impuesto al Valor Agregado",
    url: "https://www.diputados.gob.mx/LeyesBiblio/regley/Reg_LIVA_250914.pdf",
    source: "REGLAMENTO",
  },
  RCFF: {
    clave: "RCFF",
    titulo: "Reglamento del Código Fiscal de la Federación",
    url: "https://www.diputados.gob.mx/LeyesBiblio/regley/Reg_CFF.pdf",
    source: "REGLAMENTO",
    // Nuevo Reglamento publicado en el DOF el 2 de abril de 2014; sin reformas
    // desde entonces, así que el encabezado no trae «Última reforma DOF».
    vigenciaFallback: "2014-04-02",
  },
  // ── Nómina ───────────────────────────────────────────────────────────────────
  LSS: {
    clave: "LSS",
    titulo: "Ley del Seguro Social",
    url: "https://www.diputados.gob.mx/LeyesBiblio/pdf/LSS.pdf",
  },
  LINFONAVIT: {
    clave: "LINFONAVIT",
    titulo: "Ley del Instituto del Fondo Nacional de la Vivienda para los Trabajadores",
    url: "https://www.diputados.gob.mx/LeyesBiblio/pdf_mov/Ley_del_Instituto_del_Fondo_Nacional_de_la_Vivienda.pdf",
  },
  LFT: {
    clave: "LFT",
    titulo: "Ley Federal del Trabajo",
    url: "https://www.diputados.gob.mx/LeyesBiblio/pdf/LFT.pdf",
  },
  // ── Periferia de nómina (reglamentos IMSS / INFONAVIT) ──────────────────────
  RACERF: {
    clave: "RACERF",
    titulo: "Reglamento de la Ley del Seguro Social en Materia de Afiliación, Clasificación de Empresas, Recaudación y Fiscalización",
    url: "https://www.diputados.gob.mx/LeyesBiblio/regley/Reg_LSS_MACERF.pdf",
    source: "REGLAMENTO",
  },
  RIPAEDI: {
    clave: "RIPAEDI",
    titulo: "Reglamento de Inscripción, Pago de Aportaciones y Entero de Descuentos al INFONAVIT",
    // Diputados sirve el facsímil del DOF (encabezados «ARTÍCULO 1.» en mayúsculas).
    url: "https://www.diputados.gob.mx/LeyesBiblio/regla/n327.pdf",
    source: "REGLAMENTO",
    vigenciaFallback: "2012-02-10",
  },
  // ── Lo que un contador cita fuera de lo fiscal ───────────────────────────────
  CCOM: {
    clave: "CCOM",
    titulo: "Código de Comercio",
    url: "https://www.diputados.gob.mx/LeyesBiblio/pdf/CCom.pdf",
  },
  LGSM: {
    clave: "LGSM",
    titulo: "Ley General de Sociedades Mercantiles",
    url: "https://www.diputados.gob.mx/LeyesBiblio/pdf/LGSM.pdf",
  },
  LFPIORPI: {
    clave: "LFPIORPI",
    titulo: "Ley Federal para la Prevención e Identificación de Operaciones con Recursos de Procedencia Ilícita",
    url: "https://www.diputados.gob.mx/LeyesBiblio/pdf/LFPIORPI.pdf",
  },
  RLFPIORPI: {
    clave: "RLFPIORPI",
    titulo: "Reglamento de la Ley Federal para la Prevención e Identificación de Operaciones con Recursos de Procedencia Ilícita",
    url: "https://www.diputados.gob.mx/LeyesBiblio/regley/Reg_LFPIORPI.pdf",
    source: "REGLAMENTO",
    vigenciaFallback: "2013-08-16",
  },
  LFDC: {
    clave: "LFDC",
    titulo: "Ley Federal de los Derechos del Contribuyente",
    url: "https://www.diputados.gob.mx/LeyesBiblio/pdf/LFDC.pdf",
    vigenciaFallback: "2005-06-23",
  },
  // ── Estatal (impuesto sobre nómina y demás contribuciones locales) ───────────
  // Puebla: Orden Jurídico Poblano (texto vigente con tabla de reformas).
  LHPUE: {
    clave: "LHPUE",
    titulo: "Ley de Hacienda para el Estado Libre y Soberano de Puebla",
    url: "https://ojp.puebla.gob.mx/legislacion-del-estado/item/download/7789_d874b176dd9ccf4b0a3233bb2f183cd4",
    vigenciaFallback: "2024-08-05",
  },
  CFPUE: {
    clave: "CFPUE",
    titulo: "Código Fiscal del Estado de Puebla",
    url: "https://ojp.puebla.gob.mx/media/k2/attachments/Codigo_Fiscal_del_Estado_de_Puebla_T6_31072025.pdf",
    vigenciaFallback: "2025-07-31",
  },
  // CDMX: la Consejería Jurídica publica el texto vigente (reformado cada
  // diciembre; el ISN subió a 4 % — el PDF del Congreso es de 2021 y dice 3 %,
  // por eso NO se usa). El sitio de la Consejería a veces no responde; la
  // ingesta falla en voz alta y el refresco semanal reintenta.
  CFCDMX: {
    clave: "CFCDMX",
    titulo: "Código Fiscal de la Ciudad de México",
    url: "https://data.consejeria.cdmx.gob.mx/images/leyes/codigos/CODIGO_FISCAL_DE_LA_CDMX_6.2.pdf",
  },
};

export interface FetchedLey {
  descriptor: LeyDescriptor;
  rawText: string;
  /** DOF date of the latest reform found in the document header. */
  ultimaReformaDof: Date | null;
}

const MESES: Record<string, number> = {
  enero: 1, ene: 1, febrero: 2, feb: 2, marzo: 3, mar: 3, abril: 4, abr: 4, mayo: 5, may: 5, junio: 6, jun: 6,
  julio: 7, jul: 7, agosto: 8, ago: 8, septiembre: 9, sep: 9, set: 9, octubre: 10, oct: 10, noviembre: 11, nov: 11, diciembre: 12, dic: 12,
};
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

/**
 * Fecha de la última reforma según el formato de cada editor. Puro.
 *  - Diputados: «Última reforma publicada DOF 01-04-2024» / «Última Reforma DOF …».
 *  - Consejería / Congreso CDMX: «Última reforma publicada en la G.O.C.D.M.X. el 19 de diciembre de 2025».
 *  - Orden Jurídico Poblano: tabla «REFORMAS» con fechas «5/ago/2024» — se toma la mayor.
 *  - Facsímil del DOF (reglamentos viejos): «(Primera Sección) DIARIO OFICIAL Viernes 10 de febrero de 2012».
 */
export function parseFechaVigencia(text: string): Date | null {
  const dof = text.match(/Última reforma(?: publicada)? DOF (\d{2})-(\d{2})-(\d{4})/i);
  if (dof) return utc(Number(dof[3]), Number(dof[2]), Number(dof[1]));
  const go = text.match(/Última reforma publicada en la G\.?\s?O\.?\s?C\.?\s?D\.?\s?M\.?\s?X\.?\s+el\s+(\d{1,2})\s+de\s+([a-záéíóú]+)\s+(?:de\s+)?(\d{4})/i);
  if (go && MESES[go[2].toLowerCase()]) return utc(Number(go[3]), MESES[go[2].toLowerCase()], Number(go[1]));
  if (/Orden Jurídico Poblano/.test(text.slice(0, 2000))) {
    let mejor: Date | null = null;
    for (const m of text.slice(0, 40_000).matchAll(/\b(\d{1,2})\/([a-z]{3})\/(\d{4})\b/gi)) {
      const mes = MESES[m[2].toLowerCase()];
      if (!mes) continue;
      const d = utc(Number(m[3]), mes, Number(m[1]));
      if (!mejor || d > mejor) mejor = d;
    }
    if (mejor) return mejor;
  }
  const print = text.slice(0, 800).match(/DIARIO OFICIAL\s+(?:Lunes|Martes|Miércoles|Jueves|Viernes|Sábado|Domingo)\s+(\d{1,2})\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i);
  if (print && MESES[print[2].toLowerCase()]) return utc(Number(print[3]), MESES[print[2].toLowerCase()], Number(print[1]));
  return null;
}

/** @deprecated usa parseFechaVigencia (mismo comportamiento para Diputados). */
function parseDofDate(text: string): Date | null {
  return parseFechaVigencia(text);
}

export async function fetchLey(clave: string): Promise<FetchedLey> {
  const descriptor = LEYES[clave];
  if (!descriptor) {
    throw new Error(`Ley desconocida: ${clave}. Disponibles: ${Object.keys(LEYES).join(", ")}`);
  }
  const res = await fetch(descriptor.url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; contabilidad-os/fiscal-kb)", Accept: "application/pdf,*/*" } });
  if (!res.ok) throw new Error(`Descarga falló (${res.status}) — ${descriptor.url}`);
  const buffer = new Uint8Array(await res.arrayBuffer());

  // pdf-parse v2 exposes a class API; @types/pdf-parse targets v1, so we
  // require() and type the surface we use. Lazy require INSIDE the function:
  // pdf-parse → pdfjs touches DOMMatrix at load time and breaks Next.js'
  // build-time page-data collection if imported at module scope.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PDFParse } = require("pdf-parse") as {
    PDFParse: new (opts: { data: Uint8Array }) => { getText(): Promise<{ text: string }> };
  };
  const parser = new PDFParse({ data: buffer });
  const { text } = await parser.getText();
  if (!text || text.length < 10_000) {
    throw new Error(`PDF de ${clave} produjo texto sospechosamente corto (${text?.length ?? 0} chars)`);
  }
  return { descriptor, rawText: text, ultimaReformaDof: parseDofDate(text) };
}
