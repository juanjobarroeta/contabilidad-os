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
  descripcion: string | null
): Promise<ResultadoMercado & { busquedas: number }> {
  let items = await buscar(`"${numeroParte}" site:mercadolibre.com.mx`);
  let busquedas = 1;
  if (items.length === 0) {
    await pausa(1_100); // rate limit del plan gratis: 1 req/segundo
    // El fallback abierto lleva CONTEXTO: un número corto a pelo caza de todo
    // (un P82197 real regresó una base de datos de proteínas). La primera
    // palabra de la descripción o «refacción» lo anclan al mundo automotriz.
    const contexto = descripcion?.trim().split(/\s+/)[0] ?? "refacción";
    items = await buscar(`"${numeroParte}" ${contexto}`);
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

// ── Unidades (seminuevos): el rango del mercado, no un punto ────────────────

export type ResultadoMercadoVehiculo = {
  precioMin: number | null;
  precioMax: number | null;
  precioMediana: number | null;
  listados: number;
  resultados: { titulo: string; url: string; precio?: number }[];
};

const PRECIO_AUTO_RE = /\$\s?([\d]{2,3},[\d]{3}(?:,[\d]{3})?)/g;

/**
 * Busca listados comparables (marca modelo año) en autos.mercadolibre.com.mx
 * (fallback abierto con «seminuevo») y devuelve el RANGO de precios plausibles
 * (60k–3M MXN — fuera de eso es accesorio o ruido). 2 búsquedas máximo.
 */
export async function consultarMercadoVehiculo(
  marca: string | null,
  modelo: string | null,
  anio: number | null
): Promise<ResultadoMercadoVehiculo & { busquedas: number }> {
  const base = [marca, modelo, anio].filter(Boolean).join(" ").trim();
  if (!base) throw new Error("La unidad no tiene marca/modelo para buscar");

  let items = await buscar(`${base} site:autos.mercadolibre.com.mx`);
  let busquedas = 1;
  if (items.length === 0) {
    await pausa(1_100);
    items = await buscar(`${base} seminuevo precio`);
    busquedas = 2;
  }

  const precios: number[] = [];
  const resultados = items.slice(0, 8).map((it) => {
    const texto = `${it.title} ${it.description}`;
    let precio: number | undefined;
    for (const m of texto.matchAll(PRECIO_AUTO_RE)) {
      const p = Number(m[1].replace(/,/g, ""));
      if (p >= 60_000 && p <= 3_000_000) { precio = precio ?? p; precios.push(p); }
    }
    return { titulo: it.title.slice(0, 160), url: it.url, ...(precio != null ? { precio } : {}) };
  });

  precios.sort((a, b) => a - b);
  return {
    precioMin: precios[0] ?? null,
    precioMax: precios[precios.length - 1] ?? null,
    precioMediana: precios.length ? precios[Math.floor(precios.length / 2)] : null,
    listados: precios.length,
    resultados,
    busquedas,
  };
}
