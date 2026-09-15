// ─────────────────────────────────────────────────────────────────────────────
// LOS ACTIVOS QUE NACIERON DE UNA NOTA DE CRÉDITO (y los anticipos duplicados).
//
// El esquema de anticipos del SAT (Anexo 20, apéndice 6) son TRES CFDIs: el
// anticipo, el de la operación total, y una nota de crédito (tipo «E») que
// aplica el anticipo para no cobrar dos veces. Los tres llevan el mismo
// usoCfdi, así que los tres creaban activo. Visto en CENTRO: una compra de
// $26,650.87 quedó como tres activos de ~$26,650 depreciándose en paralelo.
//
// El motor ya no crea activo de una nota de crédito. Esto limpia los que
// quedaron, y LISTA —sin tocar— los pares anticipo/total que se ven duplicados,
// porque ahí hay que mirar cada caso: a veces son dos compras de verdad.
//
//   railway run bash -lc 'DATABASE_URL="${DATABASE_PUBLIC_URL:-$DATABASE_URL}" \
//     npx tsx scripts/activos-de-notas-de-credito.ts [--aplicar] [--empresa=<id>]'
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const aplicar = process.argv.includes("--aplicar");
  const empresa = process.argv.find((a) => a.startsWith("--empresa="))?.split("=")[1];

  const activos = await prisma.activoFijo.findMany({
    where: { autoCreado: true, invoiceId: { not: null }, ...(empresa ? { companyId: empresa } : {}) },
    select: { id: true, companyId: true, descripcion: true, moi: true, invoiceId: true, fechaAdquisicion: true },
  });
  const facturas = new Map(
    (
      await prisma.invoice.findMany({
        where: { id: { in: activos.map((a) => a.invoiceId!) } },
        select: { id: true, tipoSat: true, contraparteRfc: true, contraparteNombre: true, subtotal: true, fecha: true },
      })
    ).map((f) => [f.id, f]),
  );
  const empresas = new Map(
    (
      await prisma.company.findMany({
        where: { id: { in: [...new Set(activos.map((a) => a.companyId))] } },
        select: { id: true, razonSocial: true },
      })
    ).map((c) => [c.id, c.razonSocial]),
  );
  const nombre = (id: string) => (empresas.get(id) ?? id).slice(0, 26).padEnd(26);

  // 1. Nacidos de una nota de crédito: se van.
  const deNotaCredito = activos.filter((a) => (facturas.get(a.invoiceId!)?.tipoSat ?? "").trim().toUpperCase() === "E");
  console.log(`\n${deNotaCredito.length} activo(s) creados desde una NOTA DE CRÉDITO (se eliminan):`);
  for (const a of deNotaCredito) {
    console.log(`  ${nombre(a.companyId)} ${a.descripcion.replace(/\s+/g, " ").slice(0, 40).padEnd(40)} ${Number(a.moi).toFixed(2).padStart(12)}`);
  }

  // 2. Mismo proveedor y mismo importe al centavo: huele a anticipo + total.
  const porClave = new Map<string, typeof activos>();
  for (const a of activos) {
    const f = facturas.get(a.invoiceId!);
    if (!f?.contraparteRfc) continue;
    if ((f.tipoSat ?? "").trim().toUpperCase() === "E") continue;
    const clave = `${a.companyId}|${f.contraparteRfc}|${Number(a.moi).toFixed(0)}`;
    porClave.set(clave, [...(porClave.get(clave) ?? []), a]);
  }
  const dobles = [...porClave.values()].filter((g) => g.length > 1);
  console.log(`\n${dobles.length} grupo(s) con el MISMO proveedor y el MISMO importe — míralos, no se tocan:`);
  for (const g of dobles) {
    const f = facturas.get(g[0].invoiceId!);
    console.log(`  ${nombre(g[0].companyId)} ${(f?.contraparteNombre ?? f?.contraparteRfc ?? "").slice(0, 30).padEnd(30)} ${Number(g[0].moi).toFixed(2).padStart(12)} ×${g.length}`);
    for (const a of g) console.log(`      ${a.fechaAdquisicion.toISOString().slice(0, 10)}  ${a.descripcion.replace(/\s+/g, " ").slice(0, 46)}`);
  }

  if (!aplicar) { console.log(`\nSimulacro. Para eliminar los de nota de crédito: --aplicar`); return; }
  if (deNotaCredito.length > 0) {
    await prisma.activoFijo.deleteMany({ where: { id: { in: deNotaCredito.map((a) => a.id) } } });
  }
  console.log(`\n${deNotaCredito.length} activo(s) eliminados. La depreciación cambia al re-contabilizar.`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
