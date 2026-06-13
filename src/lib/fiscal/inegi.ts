// ─────────────────────────────────────────────────────────────────────────────
// Cliente mínimo del API BIE de INEGI — sólo lo que usamos para cotejar el INPC.
//
// Requiere un token gratuito de INEGI (https://www.inegi.org.mx/servicios/api_indicadores.html),
// en la env var INEGI_TOKEN. Sin token, el cotejo se omite (no rompe nada).
//
// El indicador del INPC general (base 2ª quincena jul-2018 = 100) es 628194 en
// el BIE; se puede sobreescribir con INEGI_INPC_INDICATOR por si INEGI lo cambia.
// ─────────────────────────────────────────────────────────────────────────────

const BIE_INPC_INDICATOR = process.env.INEGI_INPC_INDICATOR || "628194";

/**
 * Descarga la serie del INPC desde INEGI BIE. Devuelve un mapa "YYYY-MM" → valor.
 * Lanza si no hay token o si la respuesta no tiene el formato esperado.
 */
export async function fetchInpcInegi(): Promise<Map<string, number>> {
  const token = process.env.INEGI_TOKEN;
  if (!token) throw new Error("INEGI_TOKEN no configurado");

  // jsonxml / INDICATOR / es / 0700 (geografía nacional) / recientes=false (toda
  // la serie) / BIE / 2.0 / token
  const url =
    `https://www.inegi.org.mx/app/api/indicadores/desarrolladores/jsonxml/INDICATOR/` +
    `${BIE_INPC_INDICATOR}/es/0700/false/BIE/2.0/${token}?type=json`;

  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`INEGI respondió ${res.status}`);
  const json = (await res.json()) as {
    Series?: { OBSERVATIONS?: { TIME_PERIOD?: string; OBS_VALUE?: string }[] }[];
  };

  const obs = json.Series?.[0]?.OBSERVATIONS;
  if (!Array.isArray(obs)) throw new Error("Respuesta de INEGI sin OBSERVATIONS");

  const out = new Map<string, number>();
  for (const o of obs) {
    // TIME_PERIOD viene como "2026/05" (o "2026/05/A" en otras series).
    const tp = (o.TIME_PERIOD ?? "").replace(/\//g, "-");
    const m = /^(\d{4})-(\d{2})/.exec(tp);
    const valor = Number(o.OBS_VALUE);
    if (m && Number.isFinite(valor)) out.set(`${m[1]}-${m[2]}`, valor);
  }
  if (out.size === 0) throw new Error("INEGI no devolvió observaciones del INPC");
  return out;
}
