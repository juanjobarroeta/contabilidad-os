/**
 * Checksum de la divergencia derivado ↔ declarado (MARGOM), sólo lectura.
 *
 * Tres cortes sobre la ventana que cubre la CE importada:
 *   1. Por grupo de cuenta: lo derivado contra la balanza declarada.
 *   2. Las cuentas del taller (4301/4401) y el fallback 401.
 *   3. Ingreso posteado que cuelga de CFDIs CANCELADOS — debe ser cero después
 *      de re-postear: postMonth sólo lee STAMPED, así que lo que quede aquí es
 *      un período sin re-postear tras conocerse la cancelación.
 *
 * Uso:
 *   DATABASE_URL=<url> [DESDE=2023-01] [HASTA=2026-06] \
 *   ts-node --compiler-options '{"module":"CommonJS"}' scripts/verificar-divergencia-margom.ts
 */
import { PrismaClient } from "@prisma/client";
import { resolverEmpresa } from "./lib/empresa";

const DESDE = (process.env.DESDE ?? "2023-01").replace("-", "");
const HASTA = (process.env.HASTA ?? "2026-06").replace("-", "");

const mn = (n: number) => (n < 0 ? "-" : " ") + "$" + (Math.abs(n) / 1e6).toFixed(2) + "M";

async function main() {
  const prisma = new PrismaClient();
  try {
    const empresa = await resolverEmpresa(prisma);
    const COMPANY = empresa.id;
    console.log(`Empresa: ${empresa.razonSocial ?? empresa.rfc} (${COMPANY})`);
    const q = <T>(sql: string) => prisma.$queryRawUnsafe<T[]>(sql);
    const ventana = `BETWEEN ${DESDE} AND ${HASTA}`;

    console.log(`── grupos, ${DESDE} a ${HASTA} ───────────────────────────────`);
    const grupos = await q<{ g: string; ce: number; der: number }>(`
      WITH ce AS (
        SELECT left("numCta",1) g, SUM(haber-debe) v FROM "CeBalanzaMes"
        WHERE "companyId"='${COMPANY}' AND NOT "esPadre" AND (anio*100+mes) ${ventana} GROUP BY 1),
      der AS (
        SELECT left(c."cuentaSAT",1) g, SUM(CASE WHEN e.tipo='ABONO' THEN e.monto ELSE -e.monto END) v
        FROM "AccountingEntry" e JOIN "ChartAccount" c ON c.id=e."chartAccountId"
        WHERE e."companyId"='${COMPANY}' AND (e.year*100+e.month) ${ventana} GROUP BY 1)
      SELECT COALESCE(ce.g,der.g) g, COALESCE(ce.v,0)::float8 ce, COALESCE(der.v,0)::float8 der
      FROM ce FULL JOIN der USING (g) ORDER BY 1`);
    console.log("grupo |            CE |      derivado |     diferencia");
    for (const r of grupos) {
      console.log(`${r.g.padEnd(5)} | ${mn(r.ce).padStart(13)} | ${mn(r.der).padStart(13)} | ${mn(r.der - r.ce).padStart(14)}`);
    }

    console.log(`\n── taller y fallback ─────────────────────────────────────────`);
    const taller = await q<{ serie: string; ce: number; der: number }>(`
      WITH ce AS (
        SELECT left("numCta",4) serie, SUM(haber-debe) v FROM "CeBalanzaMes"
        WHERE "companyId"='${COMPANY}' AND NOT "esPadre" AND (anio*100+mes) ${ventana} GROUP BY 1),
      der AS (
        SELECT left(c."cuentaSAT",4) serie, SUM(CASE WHEN e.tipo='ABONO' THEN e.monto ELSE -e.monto END) v
        FROM "AccountingEntry" e JOIN "ChartAccount" c ON c.id=e."chartAccountId"
        WHERE e."companyId"='${COMPANY}' AND (e.year*100+e.month) ${ventana} GROUP BY 1)
      SELECT COALESCE(ce.serie,der.serie) serie, COALESCE(ce.v,0)::float8 ce, COALESCE(der.v,0)::float8 der
      FROM ce FULL JOIN der USING (serie)
      WHERE COALESCE(ce.serie,der.serie) IN ('401','4101','4301','4401','5101')
      ORDER BY 1`);
    console.log("serie |            CE |      derivado");
    for (const r of taller) {
      console.log(`${r.serie.padEnd(5)} | ${mn(r.ce).padStart(13)} | ${mn(r.der).padStart(13)}`);
    }

    console.log(`\n── ingreso posteado de CFDIs CANCELADOS (debe ser cero) ──────`);
    const canc = await q<{ n: bigint; v: number }>(`
      SELECT COUNT(*)::bigint n, COALESCE(SUM(CASE WHEN e.tipo='ABONO' THEN e.monto ELSE -e.monto END),0)::float8 v
      FROM "AccountingEntry" e
      JOIN "ChartAccount" c ON c.id=e."chartAccountId"
      JOIN "Invoice" i ON i.uuid=e.referencia AND i."companyId"='${COMPANY}'
      WHERE e."companyId"='${COMPANY}' AND e.fuente='CFDI' AND c."cuentaSAT" LIKE '4%'
        AND (e.year*100+e.month) ${ventana} AND i.status='CANCELLED'`);
    console.log(`asientos: ${canc[0].n}   importe: ${mn(canc[0].v)}`);
  } finally {
    await prisma.$disconnect();
  }
}

main();
