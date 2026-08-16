/**
 * Rellena Vehiculo.color desde la descripción del CFDI ya guardada en la fila
 * (colorDesdeTexto — la misma heurística que usa el derivador para unidades
 * nuevas). Sólo unidades SIN color; lo capturado a mano nunca se pisa.
 *
 * Cobertura esperada: ~6% del padrón (el color casi sólo viene en CFDIs de
 * seminuevos). El resto queda null, que es lo honesto.
 *
 * Uso:
 *   DATABASE_URL=<url> DRY_RUN=1 \
 *   ts-node --compiler-options '{"module":"CommonJS"}' scripts/backfill-color-margom.ts
 */
import { PrismaClient } from "@prisma/client";
import { colorDesdeTexto } from "../src/lib/automotriz/vin";

const DRY_RUN = process.env.DRY_RUN === "1";
const COMPANY = "cmsjf1wna003kn70fb68bqhm4"; // MARGOM

async function main() {
  const prisma = new PrismaClient();
  try {
    const filas = await prisma.vehiculo.findMany({
      where: {
        companyId: COMPANY,
        OR: [{ color: null }, { color: "" }],
        descripcionCfdi: { not: null },
      },
      select: { id: true, vin: true, descripcionCfdi: true },
    });

    let con = 0;
    for (const f of filas) {
      const color = colorDesdeTexto(f.descripcionCfdi);
      if (!color) continue;
      con++;
      console.log(`  ${DRY_RUN ? "[dry-run] " : ""}${f.vin ?? f.id}: ${color}`);
      if (!DRY_RUN) {
        await prisma.vehiculo.update({ where: { id: f.id }, data: { color } });
      }
    }
    console.log(`${DRY_RUN ? "[dry-run] " : ""}listo: ${con} con color de ${filas.length} sin color`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
