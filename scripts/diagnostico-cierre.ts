// ─────────────────────────────────────────────────────────────────────────────
// EL ESTADO DEL MES, EN UNA CORRIDA. Sólo lee.
//
// Todo lo que se verificó a mano durante el arranque de CENTRO —cuántos
// movimientos quedan sin clasificar, cuántas cuentas sin agrupador válido, si
// la balanza cuadra, qué dice cada paso del cierre— sale de las MISMAS
// funciones que pinta la app. Sin esto, cada verificación era leer código y
// adivinar; y el número de una pantalla no se podía contrastar con nada.
//
//   railway run bash -lc 'DATABASE_URL="${DATABASE_PUBLIC_URL:-$DATABASE_URL}" \
//     npx tsx scripts/diagnostico-cierre.ts --empresa=CENTRO --mes=2026-08'
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from "@prisma/client";
import { evaluarReadinessCE } from "../src/lib/contabilidad/ce-readiness";
import { evaluarCierre } from "../src/lib/cierre/evaluar";

const prisma = new PrismaClient();

function arg(nombre: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${nombre}=`))?.split("=")[1];
}

async function main() {
  const filtro = arg("empresa") ?? "";
  const mes = arg("mes") ?? "";
  const m = /^(\d{4})-(\d{2})$/.exec(mes);
  if (!filtro || !m) {
    console.log("uso: --empresa=<texto de la razón social> --mes=YYYY-MM");
    return;
  }
  const year = Number(m[1]);
  const month = Number(m[2]);

  const empresa = await prisma.company.findFirst({
    where: { razonSocial: { contains: filtro, mode: "insensitive" } },
    select: { id: true, razonSocial: true, rfc: true, regimenFiscal: true },
  });
  if (!empresa) return console.log(`No encontré ninguna empresa que contenga «${filtro}».`);

  console.log(`\n${empresa.razonSocial}  ·  ${empresa.rfc}  ·  régimen ${empresa.regimenFiscal}`);
  console.log(`Periodo ${mes}\n${"─".repeat(72)}`);

  const readiness = await evaluarReadinessCE(empresa.id, year, month);
  console.log(`CONTABILIDAD ELECTRÓNICA: ${readiness.status.toUpperCase()} — ${readiness.resumen}`);
  for (const c of readiness.checks) {
    const marca = c.estado === "ok" ? "ok  " : c.estado === "warn" ? "AVISO" : "ERROR";
    console.log(`  [${marca}] ${c.titulo}`);
    if (c.estado !== "ok") console.log(`          ${c.detalle.replace(/\s+/g, " ").slice(0, 150)}`);
  }

  const cierre = await evaluarCierre(empresa.id, year, month);
  console.log(`\nPASOS DEL CIERRE`);
  for (const p of cierre.pasos) {
    const marca = p.estadoCalculado === "listo" ? "listo   " : p.estadoCalculado === "bloquea" ? "BLOQUEA " : p.estadoCalculado === "atencion" ? "atención" : p.estadoCalculado.padEnd(8);
    console.log(`  [${marca}] ${p.titulo}${p.detalle ? ` — ${p.detalle.replace(/\s+/g, " ").slice(0, 110)}` : ""}`);
  }
  const bloquean = cierre.pasos.filter((p) => p.estadoCalculado === "bloquea");
  console.log(`\n${bloquean.length === 0 ? "Nada bloquea el cierre." : `BLOQUEAN: ${bloquean.map((p) => p.titulo).join(", ")}`}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
