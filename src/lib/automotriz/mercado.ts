// ─────────────────────────────────────────────────────────────────────────────
// El mercado de una refacción, vía Google Programmable Search (CSE) — el
// buscador está RESTRINGIDO a MercadoLibre MX (y los sitios que se agreguen
// en programmablesearchengine.google.com), así que los resultados son
// listados reales del mercado mexicano, no la web abierta.
//
// Cuota: 100 búsquedas/día gratis. Cada parte gasta 1 búsqueda (2 si el
// número no arroja nada y se reintenta con la descripción). El cron nocturno
// respeta un presupuesto por corrida y el botón de la ficha consume del
// mismo día — por eso el resultado se CACHEA en RefaccionMercado.
// ─────────────────────────────────────────────────────────────────────────────

export type ResultadoMercado = {
  titulo: string | null;
  precioMercado: number | null;
  urlPrincipal: string | null;
  resultados: { titulo: string; url: string; precio?: number }[];
};

type CseItem = {
  title?: string;
  link?: string;
  snippet?: string;
  pagemap?: { offer?: { price?: string; pricecurrency?: string }[] };
};

const PRECIO_RE = /\$\s?([\d]{2,3}(?:[,.][\d]{3})*(?:\.[\d]{2})?|[\d]{2,6}(?:\.[\d]{2})?)/;

function precioDe(item: CseItem): number | undefined {
  const ofertas = item.pagemap?.offer ?? [];
  for (const o of ofertas) {
    const p = Number(String(o.price ?? "").replace(/,/g, ""));
    if (Number.isFinite(p) && p > 0 && (o.pricecurrency == null || o.pricecurrency === "MXN")) return p;
  }
  const m = `${item.title ?? ""} ${item.snippet ?? ""}`.match(PRECIO_RE);
  if (m) {
    const p = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(p) && p >= 10 && p < 1_000_000) return p;
  }
  return undefined;
}

async function buscar(q: string): Promise<CseItem[]> {
  const key = process.env.GOOGLE_CSE_KEY;
  const cx = process.env.GOOGLE_CSE_CX;
  if (!key || !cx) throw new Error("GOOGLE_CSE_KEY/GOOGLE_CSE_CX sin configurar");
  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", key);
  url.searchParams.set("cx", cx);
  url.searchParams.set("q", q);
  url.searchParams.set("num", "5");
  url.searchParams.set("gl", "mx");
  url.searchParams.set("hl", "es");
  const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.error?.message ?? `HTTP ${res.status}`;
    // 429/cuota: el llamador decide si abortar la corrida completa.
    const err = new Error(msg) as Error & { cuotaAgotada?: boolean };
    err.cuotaAgotada = res.status === 429 || /quota|limit/i.test(msg);
    throw err;
  }
  return (data?.items ?? []) as CseItem[];
}

/** Limpia la descripción del CFDI para usarla como consulta de respaldo. */
function consultaDeDescripcion(descripcion: string | null): string | null {
  if (!descripcion) return null;
  const sinModelo = descripcion.replace(/MODELOS?\s*:.*$/i, "").trim();
  const palabras = sinModelo.split(/\s+/).slice(0, 5).join(" ");
  return palabras.length >= 6 ? `${palabras} JAC` : null;
}

/**
 * 1 búsqueda por el número de parte; si no hay resultados y hay descripción,
 * 1 más por la descripción. Devuelve el resumen listo para RefaccionMercado.
 */
export async function consultarMercado(
  numeroParte: string,
  descripcion: string | null
): Promise<ResultadoMercado & { busquedas: number }> {
  let items = await buscar(`"${numeroParte}"`);
  let busquedas = 1;
  if (items.length === 0) {
    const alterna = consultaDeDescripcion(descripcion);
    if (alterna) {
      items = await buscar(alterna);
      busquedas = 2;
    }
  }

  const resultados = items.slice(0, 5).map((it) => {
    const precio = precioDe(it);
    return {
      titulo: (it.title ?? "").slice(0, 160),
      url: it.link ?? "",
      ...(precio != null ? { precio } : {}),
    };
  }).filter((r) => r.url);

  const principal = resultados.find((r) => r.precio != null) ?? resultados[0] ?? null;
  return {
    titulo: principal?.titulo ?? null,
    precioMercado: principal?.precio ?? null,
    urlPrincipal: principal?.url ?? null,
    resultados,
    busquedas,
  };
}
