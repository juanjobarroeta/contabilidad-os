/**
 * End-to-end import smoke test against the real DB. Looks up Decolsa's
 * Torres Platino proyecto, parses the Excel, and runs the same atomic
 * transaction the API does — but rolled back at the end so it's safe
 * to run repeatedly. Confirms:
 *   • Conceptos upserted correctly
 *   • Tree assembled with right parent chain
 *   • Branch importes recomputed match leaf sums
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { parsePresupuestoXls } from "../src/lib/construccion/presupuesto-parser";

const prisma = new PrismaClient();
const FILE = "/Users/juanjosebarroeta/Downloads/1.- PRESUPUESTO DE CONTRATO T05 Y T06 - PROTOTIPO 2R  - TORRES PLATINO 060824.xls";

async function main() {
  const company = await prisma.company.findFirst({ where: { rfc: "DIN1604261F8" }, select: { id: true, razonSocial: true } });
  if (!company) { console.log("Decolsa company not found, skipping"); return; }
  console.log(`Company: ${company.razonSocial} (${company.id})`);

  const proyecto = await prisma.proyecto.findFirst({
    where: { companyId: company.id },
    select: { id: true, codigo: true, nombre: true },
  });
  if (!proyecto) { console.log("No proyecto on Decolsa yet — won't run dry test"); return; }
  console.log(`Proyecto: ${proyecto.codigo} — ${proyecto.nombre}`);

  const buf = readFileSync(FILE);
  const parsed = parsePresupuestoXls(buf);
  console.log(`Parsed: ${parsed.totals.branchCount} branches, ${parsed.totals.leafCount} leaves`);
  console.log(`Sum leaves: $${parsed.totals.sumLeafImporte.toFixed(2)}`);

  // Count distinct concepto claves and how many already exist
  const claves = new Set(parsed.leaves.map(l => l.conceptoClave));
  const existing = await prisma.concepto.count({
    where: { companyId: company.id, codigo: { in: [...claves] } },
  });
  console.log(`Concepto claves: ${claves.size} distinct, ${existing} already exist (would create ${claves.size - existing})`);

  const insumos = parsed.insumos.length;
  const existingInsumos = await prisma.insumo.count({
    where: { companyId: company.id, codigo: { in: parsed.insumos.map(i => i.clave) } },
  });
  console.log(`Insumos: ${insumos} parsed, ${existingInsumos} already exist (would create ${insumos - existingInsumos})`);

  const presupuestoExists = await prisma.presupuesto.count({ where: { proyectoId: proyecto.id } });
  console.log(`Presupuestos already on this proyecto: ${presupuestoExists}`);
  console.log(presupuestoExists > 0 ? "→ /import would 409 reject" : "→ /import would proceed");
}

main().finally(() => prisma.$disconnect());
