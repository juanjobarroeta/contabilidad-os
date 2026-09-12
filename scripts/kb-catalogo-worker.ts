/**
 * Worker de ingesta del catálogo normativo completo (leyes federales,
 * reglamentos, estatales y municipales del OJN, NOM, CDMX) — docs/MOTOR-JURIDICO.md.
 * Corre en un servicio worker de Railway (misma imagen que el worker de CE) sin
 * el tope de 300 s de una request: repite ingestCatalogoLote hasta terminar.
 *
 * Env: DATABASE_URL, OPENAI_API_KEY. Opcionales:
 *   KB_MODO=faltantes|todo   (default faltantes: sólo claves sin ninguna versión; todo: hash-skip de lo que no cambió)
 *   KB_FORCE=1               (re-chunk y re-embed aunque el texto no cambie; caro)
 *   KB_PRESUPUESTO_SEG=600   (segundos por lote antes de escribir el resumen parcial)
 */
import { PrismaClient } from "@prisma/client";
import { ingestCatalogoLote } from "../src/lib/fiscal-kb/orchestrate";

const prisma = new PrismaClient();
const log = (m: string) => console.log(`[kb ${new Date().toISOString().slice(11, 19)}] ${m}`);

async function main() {
  const soloFaltantes = (process.env.KB_MODO ?? "faltantes") !== "todo";
  const force = process.env.KB_FORCE === "1";
  const presupuesto = Number(process.env.KB_PRESUPUESTO_SEG ?? 600) || 600;
  let offset = 0;
  const tot = { procesadas: 0, ingeridas: 0, sinCambios: 0, fallidas: 0 };
  const fallidas: string[] = [];
  log(`modo=${soloFaltantes ? "faltantes" : "todo"}${force ? " FORCE" : ""}`);
  for (let vuelta = 1; ; vuelta++) {
    const r = await ingestCatalogoLote({ offset, presupuestoSegundos: presupuesto, soloFaltantes, force });
    tot.procesadas += r.procesadas;
    tot.ingeridas += r.ingeridas;
    tot.sinCambios += r.sinCambios;
    tot.fallidas += r.fallidas;
    for (const x of r.resultados) {
      if (!x.ok) {
        fallidas.push(`${x.clave}: ${x.error?.slice(0, 160)}`);
        log(`  ✗ ${x.clave}: ${x.error?.slice(0, 160)}`);
      } else if (!x.skipped) log(`  ✓ ${x.clave}: ${x.chunkCount} chunks (${x.unidades} unidades), vigente desde ${x.vigenciaDesde}`);
    }
    log(`vuelta ${vuelta}: ${r.procesadas} procesadas, ${r.ingeridas} ingeridas, ${r.sinCambios} sin cambios, ${r.fallidas} fallidas · siguiente=${r.siguiente} de ${r.total}`);
    if (r.siguiente === null) break;
    offset = r.siguiente;
  }
  log(`RESUMEN · procesadas=${tot.procesadas} ingeridas=${tot.ingeridas} sinCambios=${tot.sinCambios} fallidas=${tot.fallidas}`);
  if (fallidas.length) log(`fallidas:\n  ${fallidas.join("\n  ")}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
