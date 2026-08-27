// ─────────────────────────────────────────────────────────────────────────────
// El mercado de una refacción, vía Brave Search API.
//
// Historia: esto nació sobre Google Programmable Search, pero Google CERRÓ el
// Custom Search JSON API a clientes nuevos (403 permanente; sunset ene-2027),
// así que el proveedor es Brave — API oficial, country=mx, plan gratis de
// 2,000 búsquedas/mes y 1 req/segundo.
//
// Estrategia de búsqueda (máx 2 consultas por parte, con pausa de 1.1s por el
// rate limit): 1) el número ACOTADO a mercadolibre.com.mx — ahí viven los
// precios mexicanos; 2) si no hay nada, el número abierto — las tiendas del
// mundo identifican la parte aunque no den precio MX. El resultado se CACHEA
// en RefaccionMercado; el cron nocturno y el botón de la ficha comparten la
// misma cuota mensual.
// ─────────────────────────────────────────────────────────────────────────────

export type ResultadoMercado = {
  titulo: string | null;
  precioMercado: number | null;
  urlPrincipal: string | null;
  resultados: { titulo: string; url: string; precio?: number }[];
};

type Item = { title: string; url: string; description: string };

const PRECIO_RE = /\$\s?([\d]{2,3}(?:[,.][\d]{3})*(?:\.[\d]{2})?|[\d]{2,6}(?:\.[\d]{2})?)/;

function precioDe(item: Item): number | undefined {
  const m = `${item.title} ${item.description}`.match(PRECIO_RE);
  if (!m) return undefined;
  const p = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(p) && p >= 10 && p < 1_000_000 ? p : undefined;
}

const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function buscar(q: string): Promise<Item[]> {
  const key = process.env.BRAVE_SEARCH_KEY;
  if (!key) throw new Error("BRAVE_SEARCH_KEY sin configurar");
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", q);
  url.searchParams.set("country", "mx");
  url.searchParams.set("search_lang", "es");
  url.searchParams.set("count", "5");
  const res = await fetch(url, {
    headers: { "X-Subscription-Token": key, Accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.error?.detail ?? data?.message ?? `HTTP ${res.status}`;
    const err = new Error(String(msg).slice(0, 160)) as Error & { cuotaAgotada?: boolean };
    // 429 = rate limit o cuota mensual: el llamador decide si abortar la corrida.
    err.cuotaAgotada = res.status === 429;
    throw err;
  }
  return ((data?.web?.results ?? []) as { title?: string; url?: string; description?: string }[])
    .filter((r) => r.url)
    .map((r) => ({ title: r.title ?? "", url: r.url!, description: r.description ?? "" }));
}

/**
 * 1 búsqueda acotada a ML MX; si no arroja nada, 1 más abierta. Devuelve el
 * resumen listo para RefaccionMercado (el precio manda: el primer resultado
 * con precio detectado es el principal).
 */
export async function consultarMercado(
  numeroParte: string,
  _descripcion: string | null
): Promise<ResultadoMercado & { busquedas: number }> {
  let items = await buscar(`"${numeroParte}" site:mercadolibre.com.mx`);
  let busquedas = 1;
  if (items.length === 0) {
    await pausa(1_100); // rate limit del plan gratis: 1 req/segundo
    items = await buscar(`"${numeroParte}"`);
    busquedas = 2;
  }

  const resultados = items.slice(0, 5).map((it) => {
    const precio = precioDe(it);
    return {
      titulo: it.title.slice(0, 160),
      url: it.url,
      ...(precio != null ? { precio } : {}),
    };
  });

  const principal = resultados.find((r) => r.precio != null) ?? resultados[0] ?? null;
  return {
    titulo: principal?.titulo ?? null,
    precioMercado: principal?.precio ?? null,
    urlPrincipal: principal?.url ?? null,
    resultados,
    busquedas,
  };
}
