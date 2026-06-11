/**
 * Manual probe for the fiscal knowledge base — the Phase 0 validation gate.
 * Run the 10 real fiscal questions from the design doc and judge whether the
 * retrieved articles are the right basis before investing in more phases.
 *
 * Usage (requires DATABASE_URL + OPENAI_API_KEY):
 *   npm run fiscal:search -- "¿quién puede tributar en RESICO?"
 *   npm run fiscal:search -- "tasa de retención RESICO personas morales" --fecha 2024-06-30
 */
import { prisma } from "../src/lib/prisma";
import { searchFiscalKnowledge } from "../src/lib/fiscal-kb/search";

async function main() {
  const args = process.argv.slice(2);
  const fechaIdx = args.indexOf("--fecha");
  let fechaVigencia: Date | undefined;
  if (fechaIdx !== -1) {
    fechaVigencia = new Date(args[fechaIdx + 1]);
    args.splice(fechaIdx, 2);
  }
  const query = args.join(" ").trim();
  if (!query) {
    console.error('Uso: npm run fiscal:search -- "<consulta>" [--fecha YYYY-MM-DD]');
    process.exit(1);
  }

  const r = await searchFiscalKnowledge(query, { fechaVigencia });
  console.log(`Consulta: "${query}"  (vigencia al ${r.fechaVigenciaConsultada})\n`);
  if (r.aviso) {
    console.log(`⚠ ${r.aviso}`);
    return;
  }
  for (const hit of r.resultados) {
    console.log(`── ${hit.cita}  (similitud ${hit.similitud}, vigente desde ${hit.vigenciaDesde})`);
    if (hit.contexto) console.log(`   ${hit.contexto}`);
    console.log(`   ${hit.texto.replace(/\n/g, " ").slice(0, 280)}…\n`);
  }
}

main()
  .catch((e) => {
    console.error("✗", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
