// ─────────────────────────────────────────────────────────────────────────────
// Cliente mínimo del API SIE de Banxico — para cotejar el INPC.
//
// INEGI no expone el INPC en su API de "Banco de Indicadores" (sólo UMA), pero
// Banxico sí lo publica en su Sistema de Información Económica (SIE) como serie
// SP1 ("Índice General", mensual, índices, base 2ª quincena jul-2018=100).
//
// Token gratuito de Banxico en BANXICO_TOKEN. Serie override con BANXICO_INPC_SERIE.
// Docs: https://www.banxico.org.mx/SieAPIRest/service/v1/doc/
// ─────────────────────────────────────────────────────────────────────────────

const SERIE = process.env.BANXICO_INPC_SERIE || "SP1";

export const BANXICO_INPC_SERIE = SERIE;

/**
 * Descarga la serie del INPC desde Banxico SIE. Devuelve un mapa "YYYY-MM" → valor.
 * Lanza si no hay token o si la respuesta no tiene el formato esperado.
 */
export async function fetchInpcBanxico(): Promise<Map<string, number>> {
  const token = process.env.BANXICO_TOKEN;
  if (!token) throw new Error("BANXICO_TOKEN no configurado");

  const url = `https://www.banxico.org.mx/SieAPIRest/service/v1/series/${SERIE}/datos?token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    let body = "";
    try {
      body = (await res.text()).slice(0, 300).replace(/\s+/g, " ").trim();
    } catch {
      /* ignore */
    }
    throw new Error(`Banxico respondió ${res.status} (serie=${SERIE})${body ? ` — ${body}` : ""}`);
  }

  const json = (await res.json()) as {
    bmx?: { series?: { datos?: { fecha?: string; dato?: string }[] }[] };
  };
  const datos = json.bmx?.series?.[0]?.datos;
  if (!Array.isArray(datos)) throw new Error("Respuesta de Banxico sin datos");

  const out = new Map<string, number>();
  for (const d of datos) {
    // fecha viene como "DD/MM/YYYY"; dato como string (o "N/E" = no existe).
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d.fecha ?? "");
    const valor = Number(d.dato);
    if (m && Number.isFinite(valor)) out.set(`${m[3]}-${m[2]}`, valor);
  }
  if (out.size === 0) throw new Error("Banxico no devolvió datos del INPC");
  return out;
}
