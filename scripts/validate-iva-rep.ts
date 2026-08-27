/**
 * Validate the PPD IVA switch (bank-match → REP basis) for one company/period.
 *
 * Prints, side by side:
 *   - NEW engine (base-REP): PPD IVA from complementos de pago by FechaPago
 *   - OLD engine (bank-match): PPD IVA prorated by bank payments matched in-month
 *   - Devengado: emission-basis IVA (the upper bound / billed total)
 * plus the drivers of any NEW-vs-OLD gap, so you can trust the number before it
 * lands on a declaración. Read-only — touches nothing.
 *
 * Usage (point DATABASE_URL at the target DB):
 *   DATABASE_URL=<url> \
 *   ts-node --compiler-options '{"module":"CommonJS"}' \
 *     scripts/validate-iva-rep.ts <companyId> [year] [month]
 *
 * With no companyId it lists active companies so you can pick one.
 */
import { prisma } from "../src/lib/prisma";
import { computeTaxPosition } from "../src/lib/impuestos";

type TaxLike = { taxes: { tipo: string; retencion: boolean; importe: number }[]; totalImpuestos: number | null };
function ivaTrasladado(inv: TaxLike): number {
  const t = inv.taxes.filter((x) => x.tipo === "IVA" && !x.retencion);
  return t.length > 0 ? t.reduce((s, x) => s + x.importe, 0) : (inv.totalImpuestos ?? 0);
}
const mxn = (n: number) => n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Reconstructs the OLD bank-match PPD IVA for a tipo (INGRESO|EGRESO). */
async function oldBankPPD(companyId: string, tipo: "INGRESO" | "EGRESO", from: Date, to: Date) {
  const sign = tipo === "INGRESO" ? { gt: 0 } : { lt: 0 };
  const invs = await prisma.invoice.findMany({
    where: {
      companyId, status: "STAMPED", tipo, metodoPago: "PPD",
      bankTransactions: { some: { status: "MATCHED", fecha: { gte: from, lt: to }, monto: sign } },
    },
    include: {
      taxes: true,
      bankTransactions: { where: { status: "MATCHED", fecha: { gte: from, lt: to }, monto: sign }, select: { monto: true } },
    },
  });
  let iva = 0;
  for (const inv of invs) {
    const paid = inv.bankTransactions.reduce((s, t) => s + Math.abs(Number(t.monto)), 0);
    const total = Number(inv.total);
    const frac = total > 0 ? Math.min(1, paid / total) : 0;
    iva += ivaTrasladado({
      ...inv,
      taxes: inv.taxes.map((x) => ({ ...x, importe: Number(x.importe) })),
      totalImpuestos: inv.totalImpuestos === null ? null : Number(inv.totalImpuestos),
    }) * frac;
  }
  return { iva: r2(iva), count: invs.length };
}

/** REP payments landing in the month, split firm (2.0) vs derived (1.0). */
async function repBreakdown(companyId: string, from: Date, to: Date) {
  const links = await prisma.pagoDoctoRelacionado.findMany({
    where: { fechaPago: { gte: from, lt: to }, pagoInvoice: { companyId, tipo: "PAGO", status: "STAMPED" } },
    select: { parentUuid: true, ivaDerivado: true, ivaTrasladado: true, fechaPago: true },
  });
  const nullFecha = await prisma.pagoDoctoRelacionado.count({
    where: { fechaPago: null, pagoInvoice: { companyId, tipo: "PAGO", status: "STAMPED" } },
  });
  return {
    total: links.length,
    firm: links.filter((l) => !l.ivaDerivado).length,
    derived: links.filter((l) => l.ivaDerivado).length,
    nullFechaPago: nullFecha, // REPs not yet backfilled — invisible to the engine
  };
}

async function main() {
  const companyId = process.argv[2];
  if (!companyId) {
    const cos = await prisma.company.findMany({ where: { isActive: true }, select: { id: true, rfc: true, razonSocial: true, regimenFiscal: true } });
    console.log("Pasa un companyId. Empresas activas:");
    for (const c of cos) console.log(`  ${c.id}  ${c.rfc}  [${c.regimenFiscal}]  ${c.razonSocial ?? ""}`);
    await prisma.$disconnect();
    return;
  }
  const now = new Date();
  const year = parseInt(process.argv[3] ?? "", 10) || now.getFullYear();
  const month = parseInt(process.argv[4] ?? "", 10) || now.getMonth() + 1;
  const from = new Date(year, month - 1, 1);
  const to = new Date(year, month, 1);

  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { rfc: true, regimenFiscal: true, razonSocial: true } });
  const [pos, oldIn, oldEg, rep] = await Promise.all([
    computeTaxPosition(companyId, year, month),
    oldBankPPD(companyId, "INGRESO", from, to),
    oldBankPPD(companyId, "EGRESO", from, to),
    repBreakdown(companyId, from, to),
  ]);

  console.log(`\n${company?.rfc ?? companyId} [${company?.regimenFiscal}] — ${year}-${String(month).padStart(2, "0")}`);
  console.log(`${company?.razonSocial ?? ""}\n`);

  console.log("IVA TRASLADADO (causado)");
  console.log(`  NEW base-REP (cash):     ${mxn(pos.iva.trasladado)}`);
  console.log(`  OLD bank-match PPD only: ${mxn(oldIn.iva)}  (${oldIn.count} facturas PPD con pago en banco)`);
  console.log(`  Devengado (emisión):     ${mxn(pos.iva.devengado.trasladado)}`);

  console.log("\nIVA ACREDITABLE (gastos)");
  console.log(`  NEW base-REP (cash):     ${mxn(pos.iva.acreditable)}`);
  console.log(`  OLD bank-match PPD only: ${mxn(oldEg.iva)}  (${oldEg.count} gastos PPD con pago en banco)`);
  console.log(`  Devengado (emisión):     ${mxn(pos.iva.devengado.acreditable)}`);

  console.log("\nNETO");
  console.log(`  IVA a pagar (NEW): ${mxn(pos.iva.pagar)}   saldo a favor: ${mxn(pos.iva.saldoAFavor)}`);

  console.log("\nREP del periodo (por FechaPago)");
  console.log(`  pagos: ${rep.total}  firmes (2.0): ${rep.firm}  derivados (1.0): ${rep.derived}`);
  if (rep.nullFechaPago > 0) {
    console.log(`  ⚠️  ${rep.nullFechaPago} DoctoRelacionado SIN fechaPago — corre 'npm run backfill:rep-iva' o quedan fuera del cálculo.`);
  }
  if (rep.derived > 0) {
    console.log(`  ⚠️  ${rep.derived} pago(s) con IVA prorrateado de la factura madre (complemento 1.0, sin desglose firme).`);
  }
  console.log("");

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
