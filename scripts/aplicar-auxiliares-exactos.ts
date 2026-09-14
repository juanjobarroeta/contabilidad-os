// Aplica los enlaces EXACTOS auxiliar ↔ contraparte de una empresa (RFC como argumento) (idempotente: sólo cuentas sin customerId).
import { prisma } from "../src/lib/prisma";
import { aplicarParejas, emparejarAuxiliares } from "../src/lib/contabilidad/auxiliar-contraparte";
const RFC = process.argv.find((a) => /^[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}$/.test(a)) ?? "CPM2307076Z9";
const apply = process.argv.includes("--apply");
async function main() {
  const c = await prisma.company.findUniqueOrThrow({ where: { rfc: RFC }, select: { id: true } });
  let total = 0;
  for (const cod of ["201.01", "105.01", "107.05", "205.02", "102.01"]) {
    const e = await emparejarAuxiliares(prisma as never, c.id, cod);
    const exactas = e.pares.filter((p) => p.confianza === "EXACTA");
    const n = apply ? await aplicarParejas(prisma as never, c.id, exactas) : 0;
    total += n;
    console.log(`${cod}: exactas ${exactas.length} · aplicadas ${n} · parecidas pendientes ${e.pares.length - exactas.length} · sin pareja ${e.sinPareja.length} · ya ligadas antes ${e.yaLigados}`);
  }
  console.log(apply ? `TOTAL enlazadas: ${total}` : "(simulación; --apply para escribir)");
}
main().finally(() => prisma.$disconnect());
