/**
 * Baja la serie COMPLETA de balanzas presentadas de MARGOM (42 períodos,
 * 2023-01 → 2026-06) desde Syntage a `CeBalanzaMes`. Sólo GETs contra Syntage;
 * idempotente (salta períodos ya guardados; FORCE=1 los reemplaza — p.ej. tras
 * una complementaria).
 *
 * Uso:
 *   DATABASE_URL=<url> SYNTAGE_API_KEY=<key> TS_NODE_BASEURL=. \
 *   npx ts-node -r tsconfig-paths/register --compiler-options '{"module":"CommonJS"}' \
 *     scripts/importar-serie-ce-margom.ts
 */
import { importarSerieBalanzasSyntage } from "../src/lib/contabilidad/ce-serie";
import { PrismaClient } from "@prisma/client";
import { resolverEmpresa } from "./lib/empresa";


async function main() {
  const prisma = new PrismaClient();
  const empresa = await resolverEmpresa(prisma);
  await prisma.$disconnect();
  const COMPANY = empresa.id;
  console.log(`Empresa: ${empresa.razonSocial ?? empresa.rfc} (${COMPANY})`);
  const r = await importarSerieBalanzasSyntage(COMPANY, { force: process.env.FORCE === "1" });
  for (const p of r.periodos) {
    console.log(`  ${p.anio}-${String(p.mes).padStart(2, "0")}: ${p.accion}${p.filas ? ` (${p.filas} cuentas)` : ""}`);
  }
  console.log(`listo: ${r.importados} períodos importados de ${r.periodos.length}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
