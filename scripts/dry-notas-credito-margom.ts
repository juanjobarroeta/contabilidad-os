/**
 * Dry-run del arreglo de notas de crédito: ¿acerca lo derivado a la CE?
 *
 * Sin escribir nada. Para cada período pedido compara, sólo en el grupo 4
 * (ingresos), tres cifras del mes: lo que declara la balanza CE, lo que hoy
 * tiene el ledger posteado, y lo que produciría el motor con el espejo de
 * notas de egreso ya aplicado (balanzaPreview corre con el código de esta
 * rama). Si la hipótesis es correcta, la tercera columna se pega a la primera.
 *
 * Uso:
 *   DATABASE_URL=<url> PERIODOS=2025-01,2025-06,2026-06 \
 *   ts-node --compiler-options '{"module":"CommonJS"}' scripts/dry-notas-credito-margom.ts
 */
import { PrismaClient } from "@prisma/client";
import { balanzaPreview } from "../src/lib/contabilidad/posting";

const COMPANY = "cmsjf1wna003kn70fb68bqhm4"; // MARGOM

const fmt = (n: number) =>
  (n < 0 ? "-" : " ") + "$" + Math.abs(Math.round(n)).toLocaleString("en-US").padStart(13);

async function main() {
  const prisma = new PrismaClient();
  const periodos = (process.env.PERIODOS ?? "2025-06")
    .split(",")
    .map((p) => p.trim().split("-").map(Number) as [number, number]);
  try {
    console.log("período |      CE declarado |    ledger de hoy  |   motor con espejo |  hoy vs CE |  espejo vs CE");
    for (const [year, month] of periodos) {
      const ce = await prisma.ceBalanzaMes.aggregate({
        where: { companyId: COMPANY, anio: year, mes: month, esPadre: false, numCta: { startsWith: "4" } },
        _sum: { haber: true, debe: true },
      });
      const neto = (ce._sum.haber ?? 0) - (ce._sum.debe ?? 0);

      const hoy = await prisma.accountingEntry.findMany({
        where: { companyId: COMPANY, year, month },
        select: { monto: true, tipo: true, chartAccount: { select: { cuentaSAT: true } } },
      });
      const netoHoy = hoy
        .filter((e) => e.chartAccount.cuentaSAT.startsWith("4"))
        .reduce((a, e) => a + (e.tipo === "ABONO" ? e.monto : -e.monto), 0);

      const prev = await balanzaPreview(COMPANY, year, month);
      const netoPrev = prev
        .filter((r) => r.cuentaSAT.startsWith("4") && r.nivel > 1)
        .reduce((a, r) => a + r.abonos - r.cargos, 0);

      console.log(
        `${year}-${String(month).padStart(2, "0")} |${fmt(neto)} |${fmt(netoHoy)} |${fmt(netoPrev)} |` +
          `${fmt(netoHoy - neto)} |${fmt(netoPrev - neto)}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main();
