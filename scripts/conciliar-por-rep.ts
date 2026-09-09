// Concilia movimientos usando el desglose del complemento de pago (REP).
// Uso: npx tsx scripts/conciliar-por-rep.ts <companyId> [--aplicar] [--max N]
//
// Sin --aplicar sólo dice qué haría. El REP es autoridad: dice factura por
// factura cuánto se abonó, así que no hay ranking ni umbral que ajustar.
import { prisma } from "../src/lib/prisma";
import { conciliarPorRepEmpresa } from "../src/lib/bancos/rep-aplicar";

const fmt = (n: number) => n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });

async function main() {
  const companyId = process.argv[2];
  const aplicar = process.argv.includes("--aplicar");
  const iMax = process.argv.indexOf("--max");
  const max = iMax > 0 ? Number(process.argv[iMax + 1]) : undefined;
  if (!companyId) {
    console.error("Uso: npx tsx scripts/conciliar-por-rep.ts <companyId> [--aplicar] [--max N]");
    process.exit(1);
  }

  const r = await conciliarPorRepEmpresa(companyId, { aplicar, max });
  console.log(`\nRevisados: ${r.revisados}`);
  console.log(`  ${aplicar ? "CONCILIADOS" : "conciliaría"}: ${r.conciliados}  (${r.facturasAplicadas} facturas liquidadas)`);
  console.log(`  ambiguos (más de un REP empata): ${r.ambiguos}`);
  console.log(`  incompletos (falta algún CFDI del desglose): ${r.incompletos}`);
  console.log(`  rechazados por guard de saldo: ${r.rechazados}`);
  console.log(`  sin REP que empate: ${r.sinRep}`);
  if (r.detalle.length) {
    console.log("\ndetalle:");
    for (const d of r.detalle.slice(0, 40)) {
      console.log(`  ${d.fecha}  ${fmt(d.monto).padStart(15)}  ${d.contraparte.slice(0, 34).padEnd(34)} → ${d.facturas} factura(s)`);
    }
    if (r.detalle.length > 40) console.log(`  … y ${r.detalle.length - 40} más`);
  }
  if (r.avisos.length) {
    console.log("\navisos:");
    for (const a of r.avisos.slice(0, 15)) console.log("  " + a);
    if (r.avisos.length > 15) console.log(`  … y ${r.avisos.length - 15} más`);
  }
  await prisma.$disconnect();
}

main();
