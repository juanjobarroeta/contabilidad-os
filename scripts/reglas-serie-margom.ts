/**
 * Propone (y con APPLY escribe) las reglas de serie de MARGOM.
 *
 * Cada regla es una decisión del contador guardada como override con el
 * prefijo `serie:` (ver serie-cuenta.ts). El dry-run mide, contra la balanza
 * declarada del año, cuánto ingreso caería en la cuenta propuesta — para que la
 * decisión se tome con el número enfrente y no de memoria.
 *
 * Uso:
 *   DATABASE_URL=<url> [APPLY=1] [ANIO=2025] \
 *   ts-node --compiler-options '{"module":"CommonJS"}' scripts/reglas-serie-margom.ts
 */
import { PrismaClient } from "@prisma/client";
import { resolverEmpresa } from "./lib/empresa";

const APPLY = process.env.APPLY === "1";
const ANIO = Number(process.env.ANIO ?? 2025);

/** prefijo de serie → cuenta propuesta, con la evidencia que la sostiene. */
const PROPUESTAS: { prefijo: string; cuentaSAT: string; porque: string }[] = [
  {
    prefijo: "NCA",
    cuentaSAT: "4501-0008-0000",
    porque: "notas de cargo: comisión de colocación, GAP/UDIS, incentivos de planta",
  },
  {
    prefijo: "SM",
    cuentaSAT: "4291-0001-0000",
    porque: "seminuevos; el corte afectos/no afectos sigue pendiente del contador",
  },
];

const d = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

async function main() {
  const prisma = new PrismaClient();
  try {
    const empresa = await resolverEmpresa(prisma);
    const COMPANY = empresa.id;
    console.log(`Empresa: ${empresa.razonSocial ?? empresa.rfc} (${COMPANY})`);
    for (const p of PROPUESTAS) {
      const cuenta = await prisma.chartAccount.findFirst({
        where: { companyId: COMPANY, cuentaSAT: p.cuentaSAT, isActive: true },
        select: { id: true, nombre: true },
      });
      if (!cuenta) {
        console.log(`SIN CUENTA  ${p.cuentaSAT} no existe activa — se omite ${p.prefijo}`);
        continue;
      }
      const [derivado] = await prisma.$queryRawUnsafe<{ n: number; monto: number }[]>(`
        SELECT COUNT(*)::int n, COALESCE(SUM(subtotal),0)::float8 monto FROM "Invoice"
        WHERE "companyId"='${COMPANY}' AND tipo='INGRESO' AND status='STAMPED' AND "tipoSat"='I'
          AND upper(COALESCE(serie,'')) LIKE '${p.prefijo}%'
          AND fecha >= '${ANIO}-01-01' AND fecha < '${ANIO + 1}-01-01'`);
      const [ce] = await prisma.$queryRawUnsafe<{ v: number }[]>(`
        SELECT COALESCE(SUM(haber-debe),0)::float8 v FROM "CeBalanzaMes"
        WHERE "companyId"='${COMPANY}' AND NOT "esPadre" AND anio=${ANIO}
          AND left("numCta",4)='${p.cuentaSAT.slice(0, 4)}'`);
      const pct = ce.v !== 0 ? (derivado.monto / ce.v) * 100 : 0;
      console.log(
        `${APPLY ? "APLICA " : "[dry]  "}serie:${p.prefijo.padEnd(5)} → ${p.cuentaSAT} ${cuenta.nombre}\n` +
          `        ${ANIO}: ${derivado.n} CFDIs ${d(derivado.monto)} · serie ${p.cuentaSAT.slice(0, 4)} declarada ${d(ce.v)} · ${pct.toFixed(1)}%\n` +
          `        ${p.porque}`,
      );
      if (APPLY) {
        await prisma.postingCuentaOverride.upsert({
          where: { companyId_codigoMotor: { companyId: COMPANY, codigoMotor: `serie:${p.prefijo}` } },
          create: { companyId: COMPANY, codigoMotor: `serie:${p.prefijo}`, chartAccountId: cuenta.id },
          update: { chartAccountId: cuenta.id },
        });
      }
    }
    console.log(`\n${APPLY ? "listo — re-postear para que el ledger lo refleje." : "[dry-run] nada escrito. APPLY=1 para guardar las reglas."}`);
  } finally {
    await prisma.$disconnect();
  }
}

main();
