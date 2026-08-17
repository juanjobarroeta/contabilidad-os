/**
 * codAgrup para cuentas huérfanas de una serie de familia (MARGOM).
 *
 * La familia 28 (TRAVELER) no aparece en ningún CT presentado — sólo el ERP
 * del contador la tiene — así que #654 le recuperó el nombre pero sus tres
 * cuentas (1301/4101/5101-0028) quedaron sin codAgrup y la resolución por
 * familia (Fase 2) no las ve: su inventario derivado sale en CERO contra
 * $6.98M declarados.
 *
 * La inferencia es por UNANIMIDAD de la serie: si TODAS las demás cuentas
 * activas de la misma serie (mismo prefijo de 4 dígitos) declaran el MISMO
 * codAgrup, la huérfana lo hereda. Serie dividida o vacía → se reporta y no se
 * toca. El import del CT no lo pisa después: desde Fase 0, un CT sin la llave
 * no la borra.
 *
 * Uso (dry-run por default; APPLY=1 escribe):
 *   DATABASE_URL=<url> [APPLY=1] \
 *   ts-node --compiler-options '{"module":"CommonJS"}' scripts/backfill-codagrup-series-margom.ts
 */
import { PrismaClient } from "@prisma/client";

const COMPANY = "cmsjf1wna003kn70fb68bqhm4"; // MARGOM
const APPLY = process.env.APPLY === "1";
const SERIE_RE = /^(\d{4})-\d{4}-/;

async function main() {
  const prisma = new PrismaClient();
  try {
    const cuentas = await prisma.chartAccount.findMany({
      where: { companyId: COMPANY, isActive: true },
      select: { id: true, cuentaSAT: true, nombre: true, codAgrup: true },
    });

    const porSerie = new Map<string, { con: Set<string>; sin: typeof cuentas }>();
    for (const c of cuentas) {
      const m = SERIE_RE.exec(c.cuentaSAT);
      if (!m) continue;
      const s = porSerie.get(m[1]) ?? { con: new Set<string>(), sin: [] };
      if (c.codAgrup) s.con.add(c.codAgrup);
      else s.sin.push(c);
      porSerie.set(m[1], s);
    }

    let aplicadas = 0, reportadas = 0;
    for (const [serie, s] of [...porSerie].sort()) {
      if (s.sin.length === 0) continue;
      if (s.con.size !== 1) {
        reportadas += s.sin.length;
        console.log(`serie ${serie}: ${s.sin.length} sin codAgrup pero la serie ${s.con.size === 0 ? "no declara ninguno" : `declara ${s.con.size} distintos`} — NO se infiere`);
        continue;
      }
      const codAgrup = [...s.con][0];
      for (const c of s.sin) {
        console.log(`${APPLY ? "APLICA " : "[dry]  "} ${c.cuentaSAT}  ${c.nombre.slice(0, 38)}  → codAgrup ${codAgrup} (unánime en serie ${serie})`);
        if (APPLY) {
          await prisma.chartAccount.update({ where: { id: c.id }, data: { codAgrup } });
          aplicadas++;
        }
      }
    }
    console.log(`\n${APPLY ? "" : "[dry-run] "}listo: ${aplicadas} aplicadas, ${reportadas} reportadas sin inferencia`);
  } finally {
    await prisma.$disconnect();
  }
}

main();
