/**
 * Dry-run de la Fase 2d: ¿el taller derivado cae en las cuentas que declara la CE?
 *
 * Sin escribir nada. Por período compara, cuenta por cuenta de las series del
 * taller (4301 mano de obra, 4401 refacciones), lo declarado en la balanza CE
 * contra lo que produciría el motor de esta rama (balanzaPreview). Incluye el
 * fallback 401 para ver cuánto dejó de caer ahí.
 *
 * Uso:
 *   DATABASE_URL=<url> PERIODOS=2025-06,2026-03 \
 *   ts-node --compiler-options '{"module":"CommonJS"}' scripts/dry-taller-margom.ts
 */
import { PrismaClient } from "@prisma/client";
import { resolverEmpresa } from "./lib/empresa";
import { balanzaPreview } from "../src/lib/contabilidad/posting";

const SERIES = ["401", "4301", "4401", "1314", "5401", "601"];

const money = (n: number) => (n < 0 ? "-" : " ") + "$" + Math.abs(Math.round(n)).toLocaleString("en-US");

async function main() {
  const prisma = new PrismaClient();
  const periodos = (process.env.PERIODOS ?? "2025-06")
    .split(",")
    .map((p) => p.trim().split("-").map(Number) as [number, number]);
  try {
    const empresa = await resolverEmpresa(prisma);
    const COMPANY = empresa.id;
    console.log(`Empresa: ${empresa.razonSocial ?? empresa.rfc} (${COMPANY})`);
    for (const [year, month] of periodos) {
      console.log(`\n── ${year}-${String(month).padStart(2, "0")} ────────────────────────────────`);
      const ce = await prisma.ceBalanzaMes.findMany({
        where: { companyId: COMPANY, anio: year, mes: month, esPadre: false },
        select: { numCta: true, debe: true, haber: true },
      });
      const prev = await balanzaPreview(COMPANY, year, month);

      const cuentas = new Set<string>();
      const ceNeto = new Map<string, number>();
      for (const r of ce) {
        if (!SERIES.some((s) => r.numCta.startsWith(s))) continue;
        cuentas.add(r.numCta);
        ceNeto.set(r.numCta, (ceNeto.get(r.numCta) ?? 0) + Number(r.haber) - Number(r.debe));
      }
      const derNeto = new Map<string, number>();
      for (const r of prev) {
        if (r.nivel <= 1 || !SERIES.some((s) => r.cuentaSAT.startsWith(s))) continue;
        if (Math.abs(r.abonos - r.cargos) < 0.005) continue;
        cuentas.add(r.cuentaSAT);
        derNeto.set(r.cuentaSAT, (derNeto.get(r.cuentaSAT) ?? 0) + r.abonos - r.cargos);
      }
      // El fallback vive en la cuenta de mayor "401" (nivel 1): se lee aparte.
      const fallback = prev
        .filter((r) => r.cuentaSAT === "401")
        .reduce((a, r) => a + r.abonos - r.cargos, 0);
      if (Math.abs(fallback) > 0.005) {
        cuentas.add("401 (fallback)");
        derNeto.set("401 (fallback)", fallback);
      }

      const nombres = await prisma.chartAccount.findMany({
        where: { companyId: COMPANY, cuentaSAT: { in: [...cuentas] } },
        select: { cuentaSAT: true, nombre: true },
      });
      const nombre = new Map(nombres.map((n) => [n.cuentaSAT, n.nombre]));

      console.log("cuenta               | nombre                              |            CE |      derivado");
      for (const c of [...cuentas].sort()) {
        const a = ceNeto.get(c) ?? 0;
        const b = derNeto.get(c) ?? 0;
        if (Math.abs(a) < 0.005 && Math.abs(b) < 0.005) continue;
        console.log(
          `${c.padEnd(20)} | ${(nombre.get(c) ?? "").slice(0, 35).padEnd(35)} | ` +
            `${money(a).padStart(13)} | ${money(b).padStart(13)}`,
        );
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main();
