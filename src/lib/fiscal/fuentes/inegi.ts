// ─────────────────────────────────────────────────────────────────────────────
// INEGI — Banco de Indicadores (API BISE): UMA diaria / mensual / anual.
//
// Token gratuito (registro en el portal de desarrolladores del INEGI) en
// INEGI_TOKEN. Los ids de los indicadores de la UMA se pasan en
// INEGI_UMA_INDICADORES como "diaria,mensual,anual" (tres ids numéricos); se
// confirman con el token en mano desde el catálogo del BISE — no se adivinan.
// Sin token o sin ids, el cotejo de la UMA se omite (como el INPC sin Banxico).
//
// Formato de la API (docs INEGI):
//   https://www.inegi.org.mx/app/api/indicadores/desarrolladores/jsonxml/INDICATOR/{id}/es/00/false/BISE/2.0/{token}?type=json
//   → { Series: [{ INDICADOR, OBSERVATIONS: [{ TIME_PERIOD, OBS_VALUE }] }] }
// ─────────────────────────────────────────────────────────────────────────────

export interface UmaInegi {
  anio: number;
  diaria: number;
  mensual: number | null;
  anual: number | null;
}

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
  const json = (await res.json()) as { Series?: { OBSERVATIONS?: { TIME_PERIOD?: string; OBS_VALUE?: string }[] }[] };
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

/** UMA por año desde INEGI. Lanza si no hay configuración o la API falla. */
export async function fetchUmaInegi(): Promise<UmaInegi[]> {
  const cfg = configuracionInegi();
  if (!cfg) throw new Error("INEGI_TOKEN / INEGI_UMA_INDICADORES no configurados");
  const diaria = await serieInegi(cfg.ids.diaria, cfg.token);
  const mensual = cfg.ids.mensual ? await serieInegi(cfg.ids.mensual, cfg.token) : new Map<number, number>();
  const anual = cfg.ids.anual ? await serieInegi(cfg.ids.anual, cfg.token) : new Map<number, number>();
  return [...diaria.entries()]
    .map(([anio, d]) => ({ anio, diaria: d, mensual: mensual.get(anio) ?? null, anual: anual.get(anio) ?? null }))
    .sort((a, b) => a.anio - b.anio);
}
