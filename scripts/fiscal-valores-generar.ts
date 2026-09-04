// Genera / actualiza la capa de valores fiscales desde las fuentes oficiales:
//   - multas y cantidades del CFF  ← Anexo 5 RMF (SAT)      → src/lib/fiscal/datos/multas-cff-<Y>.json
//   - recargos (prórroga, plazos)  ← LIF (Cámara de Diputados) → src/lib/fiscal/datos/recargos-<Y>.json
//   - tarifas ISR                  ← Anexo 8 RMF (SAT)      → sólo COTEJA contra src/lib/fiscal/tarifas.ts
// y reescribe src/lib/fiscal/datos/index.ts con los JSON presentes.
//
// Los números nunca entran solos a producción: el workflow valores-fiscales.yml
// corre esto y abre un PR con el diff para revisión.
//
// Uso: npm run fiscal:valores -- --ejercicio 2026 [--anexo5 <url|archivo.pdf|.txt>]
//      [--anexo8 <…>] [--lif <…>] [--solo multas,recargos,tarifas] [--strict]

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseAnexo5 } from "../src/lib/fiscal/fuentes/anexo5";
import { parseAnexo8, tarifasCoinciden } from "../src/lib/fiscal/fuentes/anexo8";
import { parseRecargosLif, tasaMoraDesdeProrroga, urlLif } from "../src/lib/fiscal/fuentes/lif";
import { descargarAnexo } from "../src/lib/fiscal/fuentes/sat-anexos";
import { descargarBinario, textoDePdf } from "../src/lib/fiscal/fuentes/texto";
import { tarifaAnualPF, tarifaMensualSueldos } from "../src/lib/fiscal/tarifas";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const ejercicio = Number(opt("ejercicio") ?? new Date().getFullYear() + (new Date().getMonth() >= 11 ? 1 : 0));
const solo = (opt("solo") ?? "multas,recargos,tarifas").split(",").map((s) => s.trim());
const strict = args.includes("--strict");
const DATOS = join(__dirname, "..", "src", "lib", "fiscal", "datos");

async function textoDe(fuente: string): Promise<string> {
  if (/^https?:\/\//.test(fuente)) return textoDePdf(await descargarBinario(fuente));
  if (fuente.endsWith(".pdf")) return textoDePdf(readFileSync(fuente));
  return readFileSync(fuente, "utf8");
}

function escribirJson(nombre: string, datos: unknown): boolean {
  const ruta = join(DATOS, nombre);
  const nuevo = `${JSON.stringify(datos, null, 2)}\n`;
  const previo = existsSync(ruta) ? readFileSync(ruta, "utf8") : null;
  if (previo === nuevo) {
    console.log(`  = ${nombre} sin cambios`);
    return false;
  }
  writeFileSync(ruta, nuevo);
  console.log(`  ✎ ${nombre} ${previo ? "actualizado" : "creado"}`);
  return true;
}

function reescribirIndice() {
  const archivos = readdirSync(DATOS).filter((f) => f.endsWith(".json")).sort();
  const multas = archivos.filter((f) => f.startsWith("multas-cff-"));
  const recargos = archivos.filter((f) => f.startsWith("recargos-"));
  const imp = (f: string) => `${f.replace(/[^a-z0-9]/gi, "_")}`;
  const lineas = [
    "// GENERADO por scripts/fiscal-valores-generar.ts — no editar a mano.",
    "// Un ejercicio nuevo = un JSON nuevo (PR del workflow valores-fiscales.yml).",
    'import type { MultaVersionada } from "../multas";',
    'import type { RecargoVersionado } from "../recargos";',
    ...archivos.map((f) => `import ${imp(f)} from "./${f}";`),
    "",
    `export const MULTAS_CFF_GENERADAS: MultaVersionada[] = [${multas.map(imp).join(", ")}] as MultaVersionada[];`,
    `export const RECARGOS_GENERADOS: RecargoVersionado[] = [${recargos.map(imp).join(", ")}] as RecargoVersionado[];`,
    "",
  ];
  writeFileSync(join(DATOS, "index.ts"), lineas.join("\n"));
  console.log(`  ✎ index.ts (${multas.length} tablas de multas, ${recargos.length} de recargos)`);
}

/** Cierra la vigencia del ejercicio anterior (vigenciaHasta = 31-dic) si sigue abierta. */
function cerrarAnterior(prefijo: string) {
  const previo = join(DATOS, `${prefijo}-${ejercicio - 1}.json`);
  if (!existsSync(previo)) return;
  const j = JSON.parse(readFileSync(previo, "utf8")) as { vigenciaHasta: string | null };
  if (j.vigenciaHasta === null) {
    j.vigenciaHasta = `${ejercicio - 1}-12-31`;
    escribirJson(`${prefijo}-${ejercicio - 1}.json`, j);
  }
}

async function multas() {
  console.log(`Anexo 5 RMF ${ejercicio} (multas y cantidades del CFF)`);
  const src = opt("anexo5");
  let url: string | null = null;
  let texto: string;
  if (src && !/^https?:\/\//.test(src)) texto = await textoDe(src);
  else {
    const d = await descargarAnexo(5, ejercicio, src);
    url = d.url;
    texto = d.texto;
  }
  const p = parseAnexo5(texto);
  if (p.ejercicio !== ejercicio) throw new Error(`El Anexo 5 leído es de ${p.ejercicio}, no de ${ejercicio}`);
  if (p.filas.length < 80) throw new Error(`Anexo 5: sólo ${p.filas.length} filas — el parser no reconoció el documento`);
  console.log(`  ${p.filas.length} filas, ${new Set(p.filas.map((f) => f.articulo)).size} artículos, DOF ${p.dof}, vigencia ${p.vigenciaDesde}`);
  cerrarAnterior("multas-cff");
  escribirJson(`multas-cff-${ejercicio}.json`, {
    ejercicio,
    vigenciaDesde: p.vigenciaDesde ?? `${ejercicio}-01-01`,
    vigenciaHasta: null,
    fuente: `Anexo 5 RMF ${ejercicio}${p.dof ? ` (DOF ${p.dof})` : ""}`,
    dof: p.dof,
    url,
    verificado: true,
    filas: p.filas,
  });
}

async function recargos() {
  console.log(`LIF ${ejercicio} (recargos)`);
  const src = opt("lif") ?? urlLif(ejercicio);
  const texto = await textoDe(src);
  const r = parseRecargosLif(texto);
  if (!r) throw new Error("LIF: no se encontró el artículo de recargos");
  if (r.ejercicio !== ejercicio) throw new Error(`La LIF leída es de ${r.ejercicio}, no de ${ejercicio}`);
  console.log(`  Art. ${r.articulo}: prórroga ${(r.prorroga * 100).toFixed(2)} % → mora ${(tasaMoraDesdeProrroga(r.prorroga) * 100).toFixed(2)} %; parcialidades ${r.parcialidades.map((x) => `${(x.tasa * 100).toFixed(2)} %`).join(" / ")}`);
  cerrarAnterior("recargos");
  escribirJson(`recargos-${ejercicio}.json`, {
    ejercicio,
    vigenciaDesde: `${ejercicio}-01-01`,
    vigenciaHasta: null,
    fuente: `Art. ${r.articulo} LIF ${ejercicio} (prórroga); Art. 21 CFF (mora = prórroga × 1.5)`,
    url: /^https?:\/\//.test(src) ? src : null,
    verificado: true,
    articulo: r.articulo,
    prorroga: r.prorroga,
    mora: tasaMoraDesdeProrroga(r.prorroga),
    parcialidades: r.parcialidades,
  });
}

async function tarifas(): Promise<boolean> {
  console.log(`Anexo 8 RMF ${ejercicio} (tarifas ISR) — cotejo contra tarifas.ts`);
  const src = opt("anexo8");
  let texto: string;
  if (src && !/^https?:\/\//.test(src)) texto = await textoDe(src);
  else texto = (await descargarAnexo(8, ejercicio, src)).texto;
  const p = parseAnexo8(texto);
  let ok = true;
  const mensual = p.tarifas.find((t) => t.periodo === "mensual");
  const enCodigo = tarifaMensualSueldos(ejercicio);
  if (!mensual) {
    console.log("  ✗ no se encontró la tarifa mensual (Art. 96) en el Anexo");
    ok = false;
  } else if (!enCodigo || !enCodigo.vigente || enCodigo.tarifa.ejercicio !== ejercicio) {
    console.log(`  ✗ tarifas.ts no tiene la mensual de ${ejercicio} (el Anexo sí: ${mensual.filas.length} filas) — agrégala por PR`);
    ok = false;
  } else {
    const c = tarifasCoinciden(mensual.filas, enCodigo.tarifa.filas);
    console.log(`  ${c.ok ? "✓" : "✗"} mensual Art. 96 ${ejercicio}${c.ok ? " coincide" : `: ${c.diferencias.join("; ")}`}`);
    ok = ok && c.ok;
  }
  const anual = p.tarifas.find((t) => t.periodo === "anual" && t.ejercicioTarifa === ejercicio);
  const anualCodigo = tarifaAnualPF(ejercicio);
  if (!anual) {
    console.log(`  ✗ no se encontró la tarifa anual ${ejercicio} (Art. 152) en el Anexo`);
    ok = false;
  } else if (!anualCodigo || anualCodigo.ejercicio !== ejercicio) {
    console.log(`  ✗ tarifas.ts no tiene la anual de ${ejercicio} — agrégala por PR`);
    ok = false;
  } else {
    const c = tarifasCoinciden(anual.filas, anualCodigo.filas);
    console.log(`  ${c.ok ? "✓" : "✗"} anual Art. 152 ${ejercicio}${c.ok ? " coincide" : `: ${c.diferencias.join("; ")}`}`);
    ok = ok && c.ok;
  }
  return ok;
}

(async () => {
  let tarifasOk = true;
  if (solo.includes("multas")) await multas();
  if (solo.includes("recargos")) await recargos();
  reescribirIndice();
  if (solo.includes("tarifas")) tarifasOk = await tarifas();
  if (strict && !tarifasOk) {
    console.error("Tarifas: el Anexo 8 no coincide con tarifas.ts (o falta el ejercicio).");
    process.exit(1);
  }
})().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
