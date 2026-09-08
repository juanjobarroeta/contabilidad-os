// Re-etiqueta los renglones de IVA de comisión que quedaron como gasto.
//
// Antes, «IVA COMISION …» caía en PENDING_MONTHLY_CFDI junto con la comisión y
// se posteaba a comisiones bancarias: inflaba el gasto y perdía el IVA por
// acreditar (77 renglones y $5,838 en un mes en un solo hospital). Los que
// traían la abreviatura («IVA COM. TRANS. AMEX») ni siquiera se etiquetaban y
// seguían en la mesa como gasto por identificar.
//
// Sólo toca movimientos NO conciliados con un CFDI. Al re-contabilizar el mes,
// postMonth los manda a IVA acreditable pendiente.
//
// Uso: npx tsx scripts/retag-iva-comision.ts [companyId] [--apply]
import { prisma } from "../src/lib/prisma";

const APPLY = process.argv.includes("--apply");
const COMPANY = process.argv[2]?.startsWith("--") ? undefined : process.argv[2];
const ES_IVA = /\biva\b[\s.]*(com\b|com\.|comisi)/i;

async function main() {
  const txs = await prisma.bankTransaction.findMany({
    where: {
      ...(COMPANY ? { companyId: COMPANY } : {}),
      invoiceId: null,
      OR: [{ notes: "PENDING_MONTHLY_CFDI" }, { status: "UNMATCHED" }],
      descripcion: { contains: "IVA", mode: "insensitive" },
    },
    select: { id: true, companyId: true, fecha: true, monto: true, descripcion: true, status: true, notes: true },
  });
  const objetivo = txs.filter((t) => ES_IVA.test(t.descripcion));
  const porEmpresa = new Map<string, { n: number; monto: number }>();
  for (const t of objetivo) {
    const e = porEmpresa.get(t.companyId) ?? { n: 0, monto: 0 };
    e.n++; e.monto += Math.abs(Number(t.monto));
    porEmpresa.set(t.companyId, e);
  }
  for (const [cid, v] of porEmpresa) console.log(`${cid}: ${v.n} renglones · $${v.monto.toFixed(2)}`);
  console.log(`total: ${objetivo.length} movimientos${APPLY ? "" : " [dry-run]"}`);
  if (APPLY && objetivo.length > 0) {
    await prisma.bankTransaction.updateMany({
      where: { id: { in: objetivo.map((t) => t.id) } },
      data: { status: "IGNORED", notes: "IVA_COMISION" },
    });
    console.log("APLICADO — vuelve a contabilizar los meses afectados para que el asiento cambie.");
  }
  await prisma.$disconnect();
}
main();
