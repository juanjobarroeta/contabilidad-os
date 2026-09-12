/**
 * Regenera el catálogo de reglamentos federales
 * (src/lib/fiscal-kb/catalogo/reglamentos-federales.json) desde el índice de la
 * Cámara de Diputados. Entra por PR; la ingesta lo lee en runtime.
 *
 *   npm run fiscal:catalogo-reglamentos                 # descarga y escribe
 *   npm run fiscal:catalogo-reglamentos -- --file x.htm # desde un HTML local
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { DIPUTADOS_REGLAMENTOS_URL, construirCatalogoReglamentos, parsearIndiceReglamentos } from "../src/lib/fiscal-kb/catalogo/reglamentos";

const SALIDA = resolve(__dirname, "../src/lib/fiscal-kb/catalogo/reglamentos-federales.json");

async function main() {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf("--file");
  let html: string;
  if (fileIdx !== -1) html = new TextDecoder("iso-8859-1").decode(readFileSync(args[fileIdx + 1]));
  else {
    const res = await fetch(DIPUTADOS_REGLAMENTOS_URL, { headers: { "User-Agent": "Mozilla/5.0 (compatible; contabilidad-os/fiscal-kb)" } });
    if (!res.ok) throw new Error(`Índice de reglamentos: HTTP ${res.status}`);
    html = new TextDecoder("iso-8859-1").decode(new Uint8Array(await res.arrayBuffer()));
  }
  const filas = parsearIndiceReglamentos(html);
  if (filas.length < 100) throw new Error(`Sólo ${filas.length} filas: el índice cambió de forma.`);
  const entradas = construirCatalogoReglamentos(filas);
  writeFileSync(SALIDA, JSON.stringify({ fuente: DIPUTADOS_REGLAMENTOS_URL, generado: new Date().toISOString().slice(0, 10), entradas }, null, 2) + "\n");
  const porMateria = new Map<string, number>();
  for (const e of entradas) for (const m of e.materias) porMateria.set(m, (porMateria.get(m) ?? 0) + 1);
  console.log(`✓ ${SALIDA}\n  ${entradas.length} reglamentos. Materias: ${[...porMateria.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${n}`).join(", ")}`);
}

main().catch((e) => {
  console.error("✗", e instanceof Error ? e.message : e);
  process.exit(1);
});
