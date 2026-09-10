/**
 * Baja e importa la SERIE de balanzas CE de una empresa desde el SAT (e.firma,
 * navegador real) a CeBalanzaMes. Reemplazo de Syntage para CE. Requiere Chromium
 * (npx playwright install chromium) y ~512MB de RAM.
 *
 * Uso: DATABASE_URL=… CREDENTIALS_ENCRYPTION_KEY=… RFC=CBA170606FQ8 \
 *   [ANIOS=2026,2025] [FORCE=1] \
 *   npx ts-node -r tsconfig-paths/register \
 *     --compiler-options '{"module":"CommonJS","baseUrl":".","paths":{"@/*":["./src/*"]}}' \
 *     scripts/ce-serie-sat-run.ts
 */
import { PrismaClient } from "@prisma/client";
import { importarSerieBalanzasSat } from "../src/lib/contabilidad/ce-serie-sat";

async function main() {
  const rfc = process.env.RFC;
  const companyId = process.env.COMPANY_ID;
  if (!rfc && !companyId) {
    console.log("Uso: RFC=<rfc> | COMPANY_ID=<id>  [ANIOS=2026,2025] [FORCE=1]");
    return;
  }

  const prisma = new PrismaClient();
  const company = companyId
    ? await prisma.company.findUnique({ where: { id: companyId }, select: { id: true, rfc: true } })
    : await prisma.company.findFirst({ where: { rfc: rfc! }, select: { id: true, rfc: true } });
  await prisma.$disconnect();
  if (!company) throw new Error(`Sin empresa para ${rfc ?? companyId}`);

  const anios = process.env.ANIOS?.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  console.log(`CE-SAT serie · ${company.rfc}${anios?.length ? ` · años ${anios.join(",")}` : ""}`);
  const res = await importarSerieBalanzasSat(company.id, {
    anios: anios?.length ? anios : undefined,
    force: process.env.FORCE === "1",
    log: (m) => console.log("  " + m),
  });

  console.log(`\n✅ importados: ${res.importados} períodos`);
  for (const p of res.periodos) {
    console.log(`  ${p.anio}-${String(p.mes).padStart(2, "0")}  ${p.accion}${p.filas ? `  (${p.filas} cuentas)` : ""}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
