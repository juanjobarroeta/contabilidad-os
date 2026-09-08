// Consulta el CEP de Banxico para los SPEI de una empresa y guarda el RFC.
// Uso: npx tsx scripts/cep-enriquecer.ts <companyId> [max]
import { prisma } from "../src/lib/prisma";
import { enriquecerCepEmpresa } from "../src/lib/bancos/cep-enriquecer";

async function main() {
  const companyId = process.argv[2];
  const max = Number(process.argv[3] ?? 100);
  if (!companyId) { console.error("Uso: npx tsx scripts/cep-enriquecer.ts <companyId> [max]"); process.exit(1); }
  const r = await enriquecerCepEmpresa(companyId, { max });
  console.log(`candidatos=${r.candidatos} consultados=${r.consultados} conRFC=${r.conRfc} sinCEP=${r.sinCep} errores=${r.errores}`);
  if (r.primerError) console.log(`primer error: ${r.primerError}`);
  await prisma.$disconnect();
}
main();
