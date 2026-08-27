/**
 * Dry-run de la Fase 2g: ¿la venta al costo cae donde la CE la declara?
 *
 * Sin escribir nada. Por período compara las cuatro series de venta de unidad
 * (4101 normal, 4131 intercambio) y sus costos (5101, 5131) contra la balanza
 * presentada, corriendo balanzaPreview con el código de esta rama.
 *
 * Uso:
 *   DATABASE_URL=<url> PERIODOS=2025-02,2025-06,2026-06 \
 *   ts-node --compiler-options '{"module":"CommonJS"}' scripts/dry-intercambio-margom.ts
 */
import { PrismaClient } from "@prisma/client";
import { resolverEmpresa } from "./lib/empresa";
import { balanzaPreview } from "../src/lib/contabilidad/posting";

const SERIES = ["4101", "4131", "5101", "5131"];
const d = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

async function main() {
  const prisma = new PrismaClient();
  const periodos = (process.env.PERIODOS ?? "2025-06")
    .split(",").map((p) => p.trim().split("-").map(Number) as [number, number]);
  try {
    const empresa = await resolverEmpresa(prisma);
    const COMPANY = empresa.id;
    console.log(`Empresa: ${empresa.razonSocial ?? empresa.rfc} (${COMPANY})`);
    console.log("período  serie      CE declarado        derivado");
    for (const [year, month] of periodos) {
      const ce = await prisma.ceBalanzaMes.findMany({
        where: { companyId: COMPANY, anio: year, mes: month, esPadre: false },
        select: { numCta: true, debe: true, haber: true },
      });
      const prev = await balanzaPreview(COMPANY, year, month);
      for (const serie of SERIES) {
        const ingreso = serie.startsWith("4");
        const c = ce.filter((r) => r.numCta.startsWith(serie))
          .reduce((a, r) => a + (ingreso ? Number(r.haber) - Number(r.debe) : Number(r.debe) - Number(r.haber)), 0);
        const der = prev.filter((r) => r.nivel > 1 && r.cuentaSAT.startsWith(serie))
          .reduce((a, r) => a + (ingreso ? r.abonos - r.cargos : r.cargos - r.abonos), 0);
        if (Math.abs(c) < 0.5 && Math.abs(der) < 0.5) continue;
        console.log(`${year}-${String(month).padStart(2, "0")}  ${serie}  ${d(c).padStart(15)}  ${d(der).padStart(15)}`);
      }
      console.log("");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main();
