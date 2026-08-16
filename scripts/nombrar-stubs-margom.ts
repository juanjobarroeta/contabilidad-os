/**
 * Nombra las cuentas stub de la familia 28 de MARGOM (= TRAVELER, confirmada
 * al centavo contra el padrón vehicular; ver src/lib/contabilidad/nombrar-stubs.ts
 * para la evidencia completa) y corrige la naturaleza de 4201-0028-0000 (A → D).
 *
 * Conservador e idempotente: sólo toca cuentas cuyo nombre SIGUE siendo el
 * código (stubs de importarBalanza). Un nombre puesto a mano o por un catálogo
 * remandado no se pisa; re-correrlo no hace nada.
 *
 * Uso (apuntar DATABASE_URL a la base destino):
 *
 *   DATABASE_URL=<url> DRY_RUN=1 \
 *   ts-node --compiler-options '{"module":"CommonJS"}' scripts/nombrar-stubs-margom.ts
 *
 * Sin DRY_RUN aplica los cambios.
 */
import { PrismaClient } from "@prisma/client";
import {
  planNombrarStubs,
  COMPANY_MARGOM,
  NOMBRES_FAMILIA_28_MARGOM,
} from "../src/lib/contabilidad/nombrar-stubs";

const DRY_RUN = process.env.DRY_RUN === "1";

async function main() {
  const prisma = new PrismaClient();
  try {
    const codigos = NOMBRES_FAMILIA_28_MARGOM.map((c) => c.codigo);
    const existentes = await prisma.chartAccount.findMany({
      where: {
        companyId: COMPANY_MARGOM,
        OR: [{ cuentaSAT: { in: codigos } }, { subcuenta: { in: codigos } }],
      },
      select: { id: true, cuentaSAT: true, subcuenta: true, nombre: true, naturaleza: true, nivel: true },
    });

    const plan = planNombrarStubs(existentes, NOMBRES_FAMILIA_28_MARGOM);

    for (const o of plan.omitidas) console.log(`  omitida ${o.codigo}: ${o.razon}`);
    for (const a of plan.actualizaciones) {
      console.log(`  ${DRY_RUN ? "[dry-run] " : ""}${a.codigo} → ${JSON.stringify(a.data)}`);
      console.log(`      evidencia: ${a.evidencia}`);
      if (!DRY_RUN) {
        await prisma.chartAccount.update({ where: { id: a.id }, data: a.data });
      }
    }

    console.log(
      `${DRY_RUN ? "[dry-run] " : ""}listo: ${plan.actualizaciones.length} actualizadas, ` +
        `${plan.omitidas.length} omitidas`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
