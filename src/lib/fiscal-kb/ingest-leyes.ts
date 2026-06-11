// Fetch + parse leyes vigentes from the Cámara de Diputados (official texto
// vigente PDFs, public domain). Extracts the "Última reforma publicada DOF"
// date as the version's vigencia/publication marker.
//
// Phase-0 caveat (documented in docs/FISCAL-KNOWLEDGE-BASE.md §4): we use the
// DOF publication date of the latest reform as `vigenciaDesde`. Strictly,
// entry into force is governed by each decreto's transitorios — good enough
// to version texts; refine in Phase 2.

// pdf-parse v2 exposes a class API; @types/pdf-parse targets v1, so we
// require() and type the surface we use (same dodge as the CSF parser).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PDFParse } = require("pdf-parse") as {
  PDFParse: new (opts: { data: Uint8Array }) => { getText(): Promise<{ text: string }> };
};

export interface LeyDescriptor {
  clave: string;
  titulo: string;
  url: string;
}

/** Catálogo de leyes fiscales — texto vigente, Cámara de Diputados. */
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
};

export interface FetchedLey {
  descriptor: LeyDescriptor;
  rawText: string;
  /** DOF date of the latest reform found in the document header. */
  ultimaReformaDof: Date | null;
}

function parseDofDate(text: string): Date | null {
  // "Última reforma publicada DOF 01-04-2024" (body) /
  // "Última Reforma DOF 01-04-2024" (page header) — dd-mm-yyyy.
  const m = text.match(/Última reforma(?: publicada)? DOF (\d{2})-(\d{2})-(\d{4})/i);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
}

export async function fetchLey(clave: string): Promise<FetchedLey> {
  const descriptor = LEYES[clave];
  if (!descriptor) {
    throw new Error(`Ley desconocida: ${clave}. Disponibles: ${Object.keys(LEYES).join(", ")}`);
  }
  const res = await fetch(descriptor.url);
  if (!res.ok) throw new Error(`Descarga falló (${res.status}) — ${descriptor.url}`);
  const buffer = new Uint8Array(await res.arrayBuffer());

  const parser = new PDFParse({ data: buffer });
  const { text } = await parser.getText();
  if (!text || text.length < 10_000) {
    throw new Error(`PDF de ${clave} produjo texto sospechosamente corto (${text?.length ?? 0} chars)`);
  }
  return { descriptor, rawText: text, ultimaReformaDof: parseDofDate(text) };
}
