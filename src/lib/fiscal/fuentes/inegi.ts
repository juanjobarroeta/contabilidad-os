// ─────────────────────────────────────────────────────────────────────────────
// INEGI — Unidad de Medida y Actualización (UMA).
//
// Fuente principal (sin token): el comunicado de prensa anual del INEGI, PDF
// con URL predecible
//   https://www.inegi.org.mx/contenidos/saladeprensa/boletines/{Y}/uma/uma{Y}.pdf
// que dice literalmente «Diario 117.31 pesos mexicanos / Mensual 3 566.22 /
// Anual 42 794.64» y la vigencia («a partir del 1 de febrero de {Y}»).
// Verificado para 2024, 2025 y 2026.
//
// Fuente alternativa (con token): la API del Banco de Indicadores (BISE) —
// INEGI_TOKEN + INEGI_UMA_INDICADORES="id_diaria,id_mensual,id_anual". Los ids
// no se adivinan: se toman del catálogo del BISE. Sin ellos se usa el boletín.
// ─────────────────────────────────────────────────────────────────────────────

import { descargarBinario, textoDePdf } from "./texto";

export interface UmaInegi {
  anio: number;
  diaria: number;
  mensual: number | null;
  anual: number | null;
  /** «2026-02-01» cuando el boletín declara la vigencia. */
  vigenciaDesde?: string | null;
  fuente?: string;
}

export function urlBoletinUma(ejercicio: number): string {
  return `https://www.inegi.org.mx/contenidos/saladeprensa/boletines/${ejercicio}/uma/uma${ejercicio}.pdf`;
}

const num = (s: string) => Number(s.replace(/[$\s ,]/g, ""));

/** Parsea el comunicado anual de la UMA. Devuelve null si no reconoce los tres valores. Puro. */
export function parseBoletinUma(texto: string): UmaInegi | null {
  const t = texto.replace(/\s+/g, " ");
  const anioM = /(?:a partir del|vigencia a partir del)\s+1\s+de\s+febrero\s+de\s+(\d{4})/i.exec(t);
  const d = /Diario\s+\$?\s?([\d\s ]+\.\d{2})/i.exec(t);
  const m = /Mensual\s+\$?\s?([\d\s ]+\.\d{2})/i.exec(t);
  const a = /Anual\s+\$?\s?([\d\s ]+\.\d{2})/i.exec(t);
  // Formato «Año Diario Mensual Anual 2026 117.31 3 566.22 42 794.64» (cuadro).
  const fila = /\b(20\d{2})\s+\$?([\d.]+)\s+\$?([\d\s ]+\.\d{2})\s+\$?([\d\s ]+\.\d{2})/.exec(t);
  const anio = anioM ? Number(anioM[1]) : fila ? Number(fila[1]) : NaN;
  if (!Number.isFinite(anio)) return null;
  const diaria = d ? num(d[1]) : fila ? num(fila[2]) : NaN;
  const mensual = m ? num(m[1]) : fila ? num(fila[3]) : null;
  const anual = a ? num(a[1]) : fila ? num(fila[4]) : null;
  if (!Number.isFinite(diaria) || diaria < 50 || diaria > 1000) return null;
  return { anio, diaria, mensual: Number.isFinite(mensual as number) ? mensual : null, anual: Number.isFinite(anual as number) ? anual : null, vigenciaDesde: `${anio}-02-01` };
}

/** UMA del ejercicio desde el boletín oficial del INEGI (sin token). Lanza si no existe o no se reconoce. */
export async function fetchUmaBoletin(ejercicio: number): Promise<UmaInegi> {
  const url = urlBoletinUma(ejercicio);
  const texto = await textoDePdf(await descargarBinario(url));
  const r = parseBoletinUma(texto);
  if (!r) throw new Error(`INEGI: el boletín ${url} no trae los valores de la UMA en el formato esperado`);
  if (r.anio !== ejercicio) throw new Error(`INEGI: el boletín ${url} habla de ${r.anio}, no de ${ejercicio}`);
  return { ...r, fuente: url };
}

// ── API del Banco de Indicadores (opcional, con token) ───────────────────────

export function configuracionInegi(): { token: string; ids: { diaria: string; mensual?: string; anual?: string } } | null {
  const token = process.env.INEGI_TOKEN;
  const ids = (process.env.INEGI_UMA_INDICADORES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!token || ids.length === 0) return null;
  return { token, ids: { diaria: ids[0], mensual: ids[1], anual: ids[2] } };
}

async function serieInegi(id: string, token: string): Promise<Map<number, number>> {
  const url = `https://www.inegi.org.mx/app/api/indicadores/desarrolladores/jsonxml/INDICATOR/${encodeURIComponent(id)}/es/00/false/BISE/2.0/${encodeURIComponent(token)}?type=json`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`INEGI respondió ${res.status} (indicador ${id})`);
  const json = (await res.json()) as { Series?: { OBSERVATIONS?: { TIME_PERIOD?: string; OBS_VALUE?: string }[] }[] } | string[];
  if (Array.isArray(json)) throw new Error(`INEGI: ${json.join(" ")} (indicador ${id})`);
  const obs = json.Series?.[0]?.OBSERVATIONS;
  if (!Array.isArray(obs)) throw new Error(`INEGI: indicador ${id} sin observaciones`);
  return parsearObservaciones(obs);
}

/** «TIME_PERIOD» puede venir como "2026" o "2026/01"; se toma el año. Puro. */
export function parsearObservaciones(obs: { TIME_PERIOD?: string; OBS_VALUE?: string }[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const o of obs) {
    const anio = Number(String(o.TIME_PERIOD ?? "").slice(0, 4));
    const valor = Number(o.OBS_VALUE);
    if (Number.isInteger(anio) && anio > 2000 && Number.isFinite(valor) && !out.has(anio)) out.set(anio, valor);
  }
  return out;
}

/** UMA por año desde la API del INEGI. Lanza si no hay configuración o la API falla. */
export async function fetchUmaInegi(): Promise<UmaInegi[]> {
  const cfg = configuracionInegi();
  if (!cfg) throw new Error("INEGI_TOKEN / INEGI_UMA_INDICADORES no configurados");
  const diaria = await serieInegi(cfg.ids.diaria, cfg.token);
  const mensual = cfg.ids.mensual ? await serieInegi(cfg.ids.mensual, cfg.token) : new Map<number, number>();
  const anual = cfg.ids.anual ? await serieInegi(cfg.ids.anual, cfg.token) : new Map<number, number>();
  return [...diaria.entries()]
    .map(([anio, d]) => ({ anio, diaria: d, mensual: mensual.get(anio) ?? null, anual: anual.get(anio) ?? null, fuente: "INEGI (API de indicadores)" }))
    .sort((a, b) => a.anio - b.anio);
}

/** UMA del ejercicio: boletín (sin token) y, si está configurada, la API como confirmación. */
export async function fetchUma(ejercicio: number): Promise<UmaInegi> {
  const boletin = await fetchUmaBoletin(ejercicio);
  if (!configuracionInegi()) return boletin;
  try {
    const api = (await fetchUmaInegi()).find((u) => u.anio === ejercicio);
    if (api && Math.abs(api.diaria - boletin.diaria) > 0.005) {
      throw new Error(`INEGI: el boletín (${boletin.diaria}) y la API (${api.diaria}) no coinciden para ${ejercicio}`);
    }
  } catch (e) {
    if (e instanceof Error && /no coinciden/.test(e.message)) throw e;
    // La API es confirmación opcional: si falla, vale el boletín.
  }
  return boletin;
}
