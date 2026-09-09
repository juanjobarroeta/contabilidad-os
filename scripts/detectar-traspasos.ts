// Detecta traspasos entre cuentas propias por espejo.
// Uso: npx tsx scripts/detectar-traspasos.ts <companyId> [--aplicar]
import { prisma } from "../src/lib/prisma";
import { detectarTraspasosEmpresa } from "../src/lib/bancos/traspasos-aplicar";

const fmt = (n: number) => n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });

async function main() {
  const companyId = process.argv[2];
  const aplicar = process.argv.includes("--aplicar");
  if (!companyId) {
    console.error("Uso: npx tsx scripts/detectar-traspasos.ts <companyId> [--aplicar]");
    process.exit(1);
  }
  const r = await detectarTraspasosEmpresa(companyId, { aplicar });
  console.log(`\npares de traspaso: ${r.pares}   ${fmt(r.monto)}`);
  console.log(`movimientos ${aplicar ? "etiquetados" : "que se etiquetarían"}: ${r.etiquetados}`);
  for (const d of r.detalle) {
    console.log(`  ${d.fecha}  ${fmt(d.monto).padStart(14)}  ${d.salida.padEnd(34)} → ${d.entrada}`);
  }
  await prisma.$disconnect();
}
main();
