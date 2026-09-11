/**
 * Regenera el catálogo federal de leyes (src/lib/fiscal-kb/catalogo/federal.json)
 * desde el índice de la Cámara de Diputados. El JSON entra por PR: este script
 * NO toca la base; la ingesta (ingest-leyes.ts) lo lee en runtime.
 *
 *   npm run fiscal:catalogo                 # descarga el índice y escribe el JSON
 *   npm run fiscal:catalogo -- --file x.htm # desde un HTML ya descargado
 *   npm run fiscal:catalogo -- --check      # sólo compara: sale 1 si el JSON está desactualizado
 *
 * docs/MOTOR-JURIDICO.md §5.2.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { DIPUTADOS_INDEX_URL, construirCatalogo, parsearIndice, type EntradaCatalogo } from "../src/lib/fiscal-kb/catalogo/diputados";

const SALIDA = resolve(__dirname, "../src/lib/fiscal-kb/catalogo/federal.json");

async function leerIndice(file: string | null): Promise<string> {
  if (file) return new TextDecoder("iso-8859-1").decode(readFileSync(file));
  const res = await fetch(DIPUTADOS_INDEX_URL, { headers: { "User-Agent": "Mozilla/5.0 (compatible; contabilidad-os/fiscal-kb)" } });
  if (!res.ok) throw new Error(`Índice de Diputados: HTTP ${res.status}`);
  // El sitio sirve ISO-8859-1 (así lo declara el Content-Type).
  return new TextDecoder("iso-8859-1").decode(new Uint8Array(await res.arrayBuffer()));
}

function resumen(entradas: EntradaCatalogo[]): string {
  const excl = entradas.filter((e) => e.excluida);
  const porMateria = new Map<string, number>();
  for (const e of entradas) if (!e.excluida) for (const m of e.materias) porMateria.set(m, (porMateria.get(m) ?? 0) + 1);
  const top = [...porMateria.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${n}`).join(", ");
  return `${entradas.length} ordenamientos, ${excl.length} excluidos (${excl.map((e) => e.clave).join(", ")}). Materias: ${top}`;
}

async function main() {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf("--file");
  const file = fileIdx !== -1 ? args[fileIdx + 1] : null;
  const check = args.includes("--check");

  const html = await leerIndice(file);
  const filas = parsearIndice(html);
  if (filas.length < 250) throw new Error(`Sólo ${filas.length} filas: el índice cambió de forma o la descarga vino incompleta.`);
  const entradas = construirCatalogo(filas);
  const json = JSON.stringify({ fuente: DIPUTADOS_INDEX_URL, generado: new Date().toISOString().slice(0, 10), entradas }, null, 2) + "\n";

  if (check) {
    const actual = existsSync(SALIDA) ? readFileSync(SALIDA, "utf8") : "";
    const sinFecha = (s: string) => s.replace(/"generado": "[^"]*"/, "");
    if (sinFecha(actual) === sinFecha(json)) {
      console.log(`✓ federal.json al día — ${resumen(entradas)}`);
      return;
    }
    console.error("✗ federal.json desactualizado: corre `npm run fiscal:catalogo` y abre PR con el diff.");
    process.exit(1);
  }

  writeFileSync(SALIDA, json);
  console.log(`✓ ${SALIDA}\n  ${resumen(entradas)}`);
}

main().catch((e) => {
  console.error("✗", e instanceof Error ? e.message : e);
  process.exit(1);
});
