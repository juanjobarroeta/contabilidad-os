/**
 * Eval del copiloto fiscal, local (requiere DATABASE_URL con la KB, OPENAI_API_KEY
 * y ANTHROPIC_API_KEY). En producción se corre vía el workflow
 * «Eval del copiloto» (POST /api/admin/copiloto-eval, paginado).
 *
 *   npm run copiloto:eval                       # todo, con agente y juez
 *   npm run copiloto:eval -- --solo-kb          # sólo recuperación (gratis)
 *   npm run copiloto:eval -- --ids c01,c15,c27  # subconjunto
 *   npm run copiloto:eval -- --out evals/copiloto/runs/2026-09-03.json
 */
import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { prisma } from "../src/lib/prisma";
import { evaluarPregunta, resumir, type ResultadoPregunta } from "../src/lib/ai/eval/copiloto-eval";
import { PREGUNTAS_EVAL } from "../src/lib/ai/eval/preguntas";

async function main() {
  const args = process.argv.slice(2);
  const soloKb = args.includes("--solo-kb");
  const idsIdx = args.indexOf("--ids");
  const ids = idsIdx !== -1 ? args[idsIdx + 1].split(",").map((s) => s.trim()) : null;
  const outIdx = args.indexOf("--out");
  const out = outIdx !== -1 ? args[outIdx + 1] : null;

  const preguntas = ids ? PREGUNTAS_EVAL.filter((p) => ids.includes(p.id)) : PREGUNTAS_EVAL;
  const resultados: ResultadoPregunta[] = [];
  for (const p of preguntas) {
    const r = await evaluarPregunta(p, { agente: !soloKb, juez: !soloKb });
    resultados.push(r);
    const kb = r.recuperacion.hit ? "KB✓" : "KB✗";
    const cita = r.respuesta ? (r.respuesta.citaPresente ? "cita✓" : "cita✗") : "";
    const inv = r.respuesta && r.respuesta.citasFueraDeKB.length ? `INVENTA(${r.respuesta.citasFueraDeKB.join(",")})` : "";
    const juez = r.juez ? `fund${r.juez.fundamentoCorrecto ? "✓" : "✗"} noInv${r.juez.noInventa ? "✓" : "✗"} resp${r.juez.respondeLoPreguntado ? "✓" : "✗"}` : "";
    console.log(`${r.id.padEnd(4)} ${kb} ${cita.padEnd(5)} ${juez.padEnd(22)} ${inv} ${r.error ? "ERROR " + r.error : ""}`);
  }
  console.log("\nResumen:", resumir(resultados));
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ fecha: new Date().toISOString(), resumen: resumir(resultados), resultados }, null, 2));
    console.log(`Guardado en ${out}`);
  }
}

main()
  .catch((e) => {
    console.error("✗", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
