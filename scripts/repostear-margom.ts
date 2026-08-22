/**
 * Re-posteo histórico de MARGOM tras la Fase 2 (resolución por familia).
 *
 * postMonth es IDEMPOTENTE: borra y regenera CFDI/NOMINA/BANCO/DEPRECIACION
 * del período y PRESERVA lo manual. Cambiada la resolución de cuentas,
 * re-postear la historia ES la migración (docs/PLAN-motor-plan-propio.md).
 *
 * DESDE 2024-10 por default: es donde arranca la numeración por familia
 * (1301-00XX) en la CE presentada, así que es el tramo comparable. Un período
 * de ejercicio cerrado se SALTA y se reporta — no se fuerza.
 *
 * Uso (dry-run lista qué haría; APPLY=1 escribe):
 *   DATABASE_URL=<url> [DESDE=2024-10] [APPLY=1] \
 *   ts-node --compiler-options '{"module":"CommonJS"}' scripts/repostear-margom.ts
 */
import { PrismaClient } from "@prisma/client";
import { resolverEmpresa } from "./lib/empresa";
import { postMonth } from "../src/lib/contabilidad/posting";
import { PeriodoCerradoError } from "../src/lib/contabilidad/ejercicio";

const APPLY = process.env.APPLY === "1";
const DESDE = process.env.DESDE ?? "2024-10";

async function main() {
  const prisma = new PrismaClient();
  try {
    const empresa = await resolverEmpresa(prisma);
    const COMPANY = empresa.id;
    console.log(`Empresa: ${empresa.razonSocial ?? empresa.rfc} (${COMPANY})`);
    const [y0, m0] = DESDE.split("-").map(Number);
    const hoy = new Date();
    const periodos: { year: number; month: number }[] = [];
    for (let y = y0, m = m0; y < hoy.getUTCFullYear() || (y === hoy.getUTCFullYear() && m <= hoy.getUTCMonth() + 1); m === 12 ? (y++, (m = 1)) : m++) {
      periodos.push({ year: y, month: m });
    }

    const estados = await prisma.accountingPeriod.findMany({
      where: { companyId: COMPANY, OR: periodos },
      select: { year: true, month: true, status: true },
    });
    const estadoDe = new Map(estados.map((p) => [`${p.year}-${p.month}`, p.status]));

    console.log(`${APPLY ? "" : "[dry-run] "}${periodos.length} períodos desde ${DESDE}\n`);
    let ok = 0, saltados = 0, errores = 0;
    for (const p of periodos) {
      const etiqueta = `${p.year}-${String(p.month).padStart(2, "0")}`;
      const status = estadoDe.get(`${p.year}-${p.month}`) ?? "(sin período)";
      if (!APPLY) {
        console.log(`  ${etiqueta}  ${status}`);
        continue;
      }
      try {
        const r = await postMonth({ companyId: COMPANY, year: p.year, month: p.month });
        ok++;
        console.log(`  ${etiqueta}  posteado: ${r.entriesCreated} asientos${r.warnings.length ? `, ${r.warnings.length} warnings` : ""}`);
      } catch (e) {
        if (e instanceof PeriodoCerradoError) {
          saltados++;
          console.log(`  ${etiqueta}  SALTADO (ejercicio cerrado)`);
        } else {
          errores++;
          console.log(`  ${etiqueta}  ERROR: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
    if (APPLY) console.log(`\nlisto: ${ok} posteados, ${saltados} saltados, ${errores} errores`);
    else console.log(`\n[dry-run] nada escrito. APPLY=1 para postear.`);
  } finally {
    await prisma.$disconnect();
  }
}

main();
