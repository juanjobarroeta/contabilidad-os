// Reingesta a la fuerza una lista de claves del catálogo (mismo texto, chunker
// nuevo). Uso: npx tsx scripts/kb-reingestar.ts CLAVE1 CLAVE2 …  (o KB_CLAVES=a,b,c)
// Necesita DATABASE_URL, OPENAI_API_KEY (embeddings). Sirve para cuando el
// chunker aprende un formato nuevo (p. ej. encabezados con tabuladores) y
// hay que rehacer documentos que ya estaban cargados sin cambios de texto.
import { ingestLey } from "../src/lib/fiscal-kb/orchestrate";
import { prisma } from "../src/lib/prisma";

async function main() {
  const claves = [...process.argv.slice(2), ...(process.env.KB_CLAVES ?? "").split(",")].map((c) => c.trim()).filter(Boolean);
  if (!claves.length) throw new Error("Pasa claves como argumentos o en KB_CLAVES=a,b,c");
  let ok = 0;
  for (const clave of claves) {
    const t0 = Date.now();
    try {
      const r = await ingestLey(clave, { force: true });
      ok++;
      console.log(`${clave}: ${JSON.stringify(r)} · ${Math.round((Date.now() - t0) / 1000)} s`);
    } catch (e) {
      console.error(`${clave}: FALLÓ · ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`listo: ${ok}/${claves.length}`);
}

main().finally(() => prisma.$disconnect());
