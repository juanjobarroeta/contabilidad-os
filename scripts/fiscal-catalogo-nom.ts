/**
 * Catálogo de NOM desde PLATIICA (Catálogo Mexicano de Normas, SE): enumera las
 * entradas «NOM-» por el REST de WordPress, lee la ficha de cada una y escribe
 * src/lib/fiscal-kb/catalogo/nom.json. Entra por PR.
 *
 *   npm run fiscal:catalogo-nom                # todas (1 200+ fichas, ~10 min)
 *   npm run fiscal:catalogo-nom -- --max 50    # prueba
 *
 * Sólo las vigentes con PDF público quedan sin `excluida`; y sólo las de
 * construcción (esNomConstruccion) entran a la ingesta por default — ver
 * catalogo/fuentes.ts.
 */
import { writeFileSync } from "fs";
import { resolve } from "path";
import { PLATIICA_REST, esNomConstruccion, hostPublico, parsearFichaNom, type EntradaNom } from "../src/lib/fiscal-kb/catalogo/nom";

const SALIDA = resolve(__dirname, "../src/lib/fiscal-kb/catalogo/nom.json");
const UA = { "User-Agent": "Mozilla/5.0 (compatible; contabilidad-os/fiscal-kb)" };

async function json<T>(url: string): Promise<{ data: T; headers: Headers }> {
  for (let intento = 1; ; intento++) {
    const res = await fetch(url, { headers: UA });
    if (res.ok) return { data: (await res.json()) as T, headers: res.headers };
    if (intento >= 3) throw new Error(`HTTP ${res.status} ${url}`);
    await new Promise((r) => setTimeout(r, 1500 * intento));
  }
}

async function main() {
  const args = process.argv.slice(2);
  const maxIdx = args.indexOf("--max");
  const max = maxIdx !== -1 ? Number(args[maxIdx + 1]) : Infinity;

  // 1) Enumerar: búsqueda «NOM-» paginada (100 por página).
  const ids: { id: number; titulo: string; url: string }[] = [];
  for (let page = 1; ; page++) {
    const { data, headers } = await json<{ id: number; title: string; url: string; subtype: string }[]>(`${PLATIICA_REST}/search?search=NOM-&per_page=100&page=${page}`);
    for (const x of data) if (x.subtype === "post" && /NOM-/i.test(x.title)) ids.push({ id: x.id, titulo: x.title, url: hostPublico(x.url) });
    const total = Number(headers.get("x-wp-totalpages") ?? "1");
    if (page >= total || ids.length >= max) break;
  }
  console.log(`${ids.length} entradas NOM en el catálogo`);

  // 2) Ficha de cada una (con concurrencia moderada: es un WordPress).
  const entradas: EntradaNom[] = [];
  let i = 0;
  let fallidas = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (;;) {
        const k = i++;
        if (k >= Math.min(ids.length, max)) return;
        const it = ids[k];
        try {
          const { data } = await json<{ title: { rendered: string }; content: { rendered: string }; link: string }>(`${PLATIICA_REST}/posts/${it.id}`);
          const e = parsearFichaNom(data.title.rendered, data.content.rendered, hostPublico(data.link));
          if (e) entradas.push(e);
        } catch (err) {
          fallidas++;
          console.error(`  ${it.titulo}: ${err instanceof Error ? err.message : err}`);
        }
        if ((k + 1) % 100 === 0) console.log(`  ${k + 1}/${ids.length}…`);
      }
    })
  );
  entradas.sort((a, b) => a.clave.localeCompare(b.clave));
  const vigentes = entradas.filter((e) => !e.excluida);
  const construccion = vigentes.filter((e) => esNomConstruccion(e.clave, e.titulo));
  writeFileSync(SALIDA, JSON.stringify({ fuente: PLATIICA_REST, generado: new Date().toISOString().slice(0, 10), entradas }, null, 2) + "\n");
  console.log(`✓ ${SALIDA}\n  ${entradas.length} NOM (${vigentes.length} vigentes con PDF; ${construccion.length} de construcción; ${fallidas} fichas fallidas)`);
  console.log("  construcción:", construccion.map((e) => e.clave).join(" "));
}

main().catch((e) => {
  console.error("✗", e instanceof Error ? e.message : e);
  process.exit(1);
});
