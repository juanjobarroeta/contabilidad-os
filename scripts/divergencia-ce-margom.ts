/**
 * Divergencia mensual CE ↔ padrón por familia (MARGOM), en flujo NETO.
 *
 * Por qué NETO (debe − haber): el contador rutea valor A TRAVÉS de las cuentas
 * de inventario más allá de las unidades — desde 2024-10: $1,360M de debe y
 * $1,412M de haber EXCEDENTES y simétricos (±4%) sobre los flujos del padrón.
 * Son traspasos/estadías que inflan ambos lados y se cancelan en el neto; el
 * debe bruto no sirve para señalar meses (la primera versión de este análisis
 * cayó ahí).
 *
 * Para cada familia con cuenta 1301-00XX: neto CE del mes vs neto padrón del
 * mes (compras − costo de vendidas). Un mes con |dif| > umbral es un mes cuyos
 * CFDIs hay que revisar — el punto es auditar ESE mes, no la ventana de 5 años.
 *
 * Sólo lectura. Uso:
 *   DATABASE_URL=<url> UMBRAL=500000 \
 *   ts-node --compiler-options '{"module":"CommonJS"}' scripts/divergencia-ce-margom.ts
 */
import { PrismaClient } from "@prisma/client";
import { FAMILIAS } from "../src/lib/contabilidad/familia-vehiculo";

const COMPANY = "cmsjf1wna003kn70fb68bqhm4"; // MARGOM
const DESDE = "2024-10-01"; // numeración nueva (1301-00XX = familias)
const UMBRAL = Number(process.env.UMBRAL ?? 500_000);


async function main() {
  const prisma = new PrismaClient();
  try {
    const caseSql = FAMILIAS.map(([, sub, re]) => `WHEN t ~ '${re}' THEN '${sub}'`).join("\n      ");
    const filas = await prisma.$queryRawUnsafe<
      { sub: string; mes: string; padron_neto: number; ce_neto: number; u_compradas: number }[]
    >(`
      WITH unidades AS (
        SELECT CASE ${"\n      "}${caseSql} ELSE NULL END sub,
               date_trunc('month', COALESCE("fechaCompra","createdAt"))::date mc,
               date_trunc('month', "fechaVenta")::date mv,
               "costoCompra" costo
        FROM (SELECT *, UPPER(COALESCE(modelo,'')||' '||COALESCE(version,'')||' '||COALESCE(marca,'')) t
              FROM "Vehiculo" WHERE "companyId"='${COMPANY}' AND tipo='NUEVO') v
      ),
      pad AS (
        SELECT sub, m, SUM(compras) compras, SUM(vtas) vtas, SUM(u) u FROM (
          SELECT sub, mc m, costo compras, 0 vtas, 1 u FROM unidades WHERE sub IS NOT NULL
          UNION ALL
          SELECT sub, mv m, 0, costo, 0 FROM unidades WHERE sub IS NOT NULL AND mv IS NOT NULL
        ) x GROUP BY 1, 2
      ),
      ce AS (
        SELECT SUBSTRING("numCta" FROM 6 FOR 4) sub, make_date(anio,mes,1) m, SUM(debe-haber) neto
        FROM "CeBalanzaMes"
        WHERE "companyId"='${COMPANY}' AND "numCta" LIKE '1301-%' AND NOT "esPadre"
        GROUP BY 1, 2
      )
      SELECT COALESCE(ce.sub, pad.sub) sub, TO_CHAR(COALESCE(ce.m, pad.m),'YYYY-MM') mes,
             COALESCE(pad.compras,0) - COALESCE(pad.vtas,0) padron_neto,
             COALESCE(ce.neto,0) ce_neto,
             COALESCE(pad.u,0)::int u_compradas
      FROM ce FULL JOIN pad ON pad.sub = ce.sub AND pad.m = ce.m
      WHERE COALESCE(ce.m, pad.m) >= '${DESDE}'
        -- meses posteriores a la última balanza presentada no son divergencia:
        -- todavía no hay CE contra qué comparar.
        AND COALESCE(ce.m, pad.m) <= (SELECT MAX(make_date(anio,mes,1)) FROM "CeBalanzaMes" WHERE "companyId"='${COMPANY}')
      ORDER BY 1, 2
    `);

    let familiaActual = "";
    let acum = 0;
    for (const f of filas) {
      const dif = f.ce_neto - f.padron_neto;
      if (f.sub !== familiaActual) {
        if (familiaActual) console.log(`  ── acumulado: ${fmt(acum)}\n`);
        const nombre = FAMILIAS.find(([, sub]) => sub === f.sub)?.[0] ?? f.sub;
        console.log(`${nombre} (1301-${f.sub}):`);
        familiaActual = f.sub;
        acum = 0;
      }
      acum += dif;
      if (Math.abs(dif) > UMBRAL) {
        console.log(
          `  ${f.mes}  padrón ${fmt(f.padron_neto)}  CE ${fmt(f.ce_neto)}  dif ${fmt(dif)}` +
            (f.u_compradas ? `  (${f.u_compradas} compradas)` : ""),
        );
      }
    }
    if (familiaActual) console.log(`  ── acumulado: ${fmt(acum)}`);
    console.log(`\numbral: ±$${UMBRAL.toLocaleString("en-US")}; período: desde ${DESDE}. ` +
      `El acumulado por familia ≈ su renglón en la tabla de conciliación por saldos.`);
  } finally {
    await prisma.$disconnect();
  }
}

const fmt = (n: number) =>
  `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
