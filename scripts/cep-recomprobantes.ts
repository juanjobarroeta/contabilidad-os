// Repara los CEP consultados ANTES de que el comprobante se guardara: vuelve a
// pedirle a Banxico el XML de los SPEI que tienen `cepAt` sellado y ninguna
// evidencia. Manual y acotado a propósito — cada movimiento es una llamada al
// proveedor. Ver el bloque de reconsultarComprobantesEmpresa.
//
// Uso:
//   npx tsx scripts/cep-recomprobantes.ts            → toda la cartera
//   npx tsx scripts/cep-recomprobantes.ts <companyId> [max]
//   npx tsx scripts/cep-recomprobantes.ts --dry       → sólo cuenta, no consulta
import { prisma } from "../src/lib/prisma";
import { reconsultarComprobantesEmpresa } from "../src/lib/bancos/cep-enriquecer";

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const companyId = args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a)) ?? null;
  const max = Number(args.find((a) => /^\d+$/.test(a)) ?? 200);

  if (!dry && !process.env.TLALOC_API_KEY?.trim()) {
    console.error("Falta TLALOC_API_KEY (corre con `railway run`).");
    process.exit(1);
  }

  // Las empresas que TIENEN algo que reparar: agrupar primero evita recorrer la
  // cartera entera para descubrir que no hay nada que hacer.
  const pendientes = await prisma.bankTransaction.groupBy({
    by: ["companyId"],
    where: {
      ...(companyId ? { companyId } : {}),
      claveRastreo: { not: null },
      contraparteClabe: { not: null },
      cepAt: { not: null },
      cepMovimiento: { is: null },
    },
    _count: { _all: true },
  });

  if (pendientes.length === 0) {
    console.log("No hay movimientos sellados sin comprobante. Nada que reparar.");
    await prisma.$disconnect();
    return;
  }

  const nombres = new Map(
    (await prisma.company.findMany({
      where: { id: { in: pendientes.map((p) => p.companyId) } },
      select: { id: true, razonSocial: true },
    })).map((c) => [c.id, c.razonSocial]),
  );

  const total = pendientes.reduce((s, p) => s + p._count._all, 0);
  console.log(`${total} movimiento(s) sin comprobante en ${pendientes.length} empresa(s):`);
  for (const p of pendientes) {
    console.log(`  ${(nombres.get(p.companyId) ?? p.companyId).slice(0, 40)} — ${p._count._all}`);
  }
  if (dry) {
    console.log("\n--dry: no se consultó nada.");
    await prisma.$disconnect();
    return;
  }

  console.log("");
  let comprobantes = 0, consultados = 0, sinCep = 0, errores = 0;
  for (const p of pendientes) {
    const r = await reconsultarComprobantesEmpresa(p.companyId, { max });
    comprobantes += r.comprobantes; consultados += r.consultados;
    sinCep += r.sinCep; errores += r.errores;
    console.log(
      `${(nombres.get(p.companyId) ?? p.companyId).slice(0, 40).padEnd(42)}` +
      `consultados=${r.consultados} comprobantes=${r.comprobantes} sinCEP=${r.sinCep} ` +
      `RFCs=${r.rfcsRellenados} cuentas=${r.cuentasAprendidas} errores=${r.errores}`,
    );
    if (r.primerError) console.log(`   primer error: ${r.primerError}`);
  }

  console.log("");
  console.log(`TOTAL consultados=${consultados} comprobantes=${comprobantes} sinCEP=${sinCep} errores=${errores}`);
  if (sinCep > 0) {
    console.log(
      `\n${sinCep} sin comprobante en Banxico: traspasos entre cuentas propias o claves mal leídas.\n` +
      "Volver a correr esto los consultaría otra vez — no lo hagas sin una razón nueva.",
    );
  }
  await prisma.$disconnect();
}

main();
