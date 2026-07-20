/**
 * Smoke test for the purificadora → accounting integration (the three money
 * loops: venta de contado, venta a crédito + cobro, y gasto de operación).
 *
 * Run:
 *   set -a; . ./.env.local; set +a
 *   node scripts/validate-purificadora-postings.mjs
 *
 * What it does:
 *   1. Picks (or fails asking you to enable) a Company with PURIFICADORA.
 *   2. Venta de contado (EFECTIVO): inserta la venta y corre la misma
 *      transacción que POST /api/purificadora/ventas (DR 1100 / CR 4170).
 *   3. Venta a crédito: DR 1103 / CR 4170 al vender, luego el cobro
 *      (DR 1101 / CR 1103) como PATCH {action:"cobrar", TRANSFERENCIA}.
 *   4. Gasto de operación (TRANSFERENCIA): DR 5203 / CR 1101.
 *   5. Asserts por referencia: Σ CARGO = Σ ABONO, fuente=PURIFICADORA,
 *      cuentas esperadas tocadas.
 *   6. Cleans up unless KEEP=1.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const KEEP = process.env.KEEP === "1";
const TEST_TAG = `[validate-purif-${Date.now()}]`;

const log = (...a) => console.log(...a);
const fail = (msg) => {
  console.error("❌", msg);
  process.exit(1);
};
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const DEFAULT_ACCOUNTS = [
  { cuentaSAT: "1100", nombre: "Caja", tipo: "ACTIVO" },
  { cuentaSAT: "1101", nombre: "Bancos", tipo: "ACTIVO" },
  { cuentaSAT: "1103", nombre: "Cuentas por cobrar", tipo: "ACTIVO" },
  { cuentaSAT: "2102", nombre: "IVA trasladado", tipo: "PASIVO" },
  { cuentaSAT: "2104", nombre: "Acreedores diversos", tipo: "PASIVO" },
  { cuentaSAT: "4170", nombre: "Ingresos por venta de agua purificada", tipo: "INGRESO" },
  { cuentaSAT: "5203", nombre: "Gastos de operación purificadora", tipo: "GASTO" },
];

async function getOrCreateAccount(tx, companyId, cuentaSAT) {
  const existing = await tx.chartAccount.findFirst({
    where: { companyId, cuentaSAT, subcuenta: null },
    select: { id: true },
  });
  if (existing) return existing;
  const def = DEFAULT_ACCOUNTS.find((a) => a.cuentaSAT === cuentaSAT);
  if (!def) throw new Error(`No default for ${cuentaSAT}`);
  return tx.chartAccount.create({
    data: { companyId, cuentaSAT: def.cuentaSAT, nombre: def.nombre, tipo: def.tipo },
    select: { id: true },
  });
}

async function postLegs(tx, companyId, fecha, desc, referencia, referenciaTipo, legs) {
  const year = fecha.getUTCFullYear();
  const month = fecha.getUTCMonth() + 1;
  const data = [];
  for (const leg of legs) {
    const account = await getOrCreateAccount(tx, companyId, leg.cuentaSAT);
    data.push({
      companyId,
      chartAccountId: account.id,
      fecha,
      year,
      month,
      descripcion: desc,
      referencia,
      referenciaTipo,
      monto: leg.monto,
      tipo: leg.tipo,
      fuente: "PURIFICADORA",
    });
  }
  await tx.accountingEntry.createMany({ data });
}

async function assertBalanced(referencia, expectedAccounts) {
  const entries = await prisma.accountingEntry.findMany({
    where: { referencia },
    include: { chartAccount: { select: { cuentaSAT: true } } },
  });
  if (!entries.length) fail(`No entries for referencia ${referencia}`);
  const cargos = round2(
    entries.filter((e) => e.tipo === "CARGO").reduce((s, e) => s + e.monto, 0)
  );
  const abonos = round2(
    entries.filter((e) => e.tipo === "ABONO").reduce((s, e) => s + e.monto, 0)
  );
  if (cargos !== abonos) fail(`Unbalanced for ${referencia}: CARGO ${cargos} ≠ ABONO ${abonos}`);
  for (const e of entries) {
    if (e.fuente !== "PURIFICADORA") fail(`fuente ${e.fuente} ≠ PURIFICADORA`);
  }
  const touched = new Set(entries.map((e) => e.chartAccount.cuentaSAT));
  for (const acc of expectedAccounts) {
    if (!touched.has(acc)) fail(`Expected account ${acc} touched for ${referencia}, got ${[...touched]}`);
  }
  log(`  ✓ ${referencia}: ${entries.length} legs, Σ ${cargos} balanced, accounts ${[...touched].join("/")}`);
  return entries;
}

async function main() {
  const moduleRow = await prisma.companyModule.findFirst({
    where: { modulo: "PURIFICADORA", habilitado: true },
    include: { company: { select: { id: true, rfc: true, razonSocial: true } } },
  });
  if (!moduleRow) {
    fail(
      "No company has PURIFICADORA enabled. Run: node scripts/enable-purificadora-module.mjs <rfc>"
    );
  }
  const company = moduleRow.company;
  log(`Using company ${company.razonSocial} (${company.rfc})`);

  const fecha = new Date();
  const created = { ventas: [], gastos: [] };

  // ── 1. Venta de contado (2 garrafones × $15, EFECTIVO) ─────────────────────
  const ventaContado = await prisma.$transaction(async (tx) => {
    const v = await tx.purifVenta.create({
      data: {
        companyId: company.id,
        folio: `VTEST-${Date.now()}-1`,
        fecha,
        formaPago: "EFECTIVO",
        estado: "COBRADA",
        subtotal: 30,
        iva: 0,
        total: 30,
        garrafones: 2,
        notas: TEST_TAG,
      },
    });
    await postLegs(tx, company.id, fecha, `Venta ${v.folio} ${TEST_TAG}`, v.id, "PURIF_VENTA", [
      { cuentaSAT: "1100", monto: 30, tipo: "CARGO" },
      { cuentaSAT: "4170", monto: 30, tipo: "ABONO" },
    ]);
    return v;
  });
  created.ventas.push(ventaContado.id);
  log(`\nVenta de contado ${ventaContado.folio}:`);
  await assertBalanced(ventaContado.id, ["1100", "4170"]);

  // ── 2. Venta a crédito (10 garrafones × $15) + cobro por transferencia ─────
  const ventaCredito = await prisma.$transaction(async (tx) => {
    const v = await tx.purifVenta.create({
      data: {
        companyId: company.id,
        folio: `VTEST-${Date.now()}-2`,
        fecha,
        formaPago: "CREDITO",
        estado: "PENDIENTE",
        subtotal: 150,
        iva: 0,
        total: 150,
        garrafones: 10,
        notas: TEST_TAG,
      },
    });
    await postLegs(tx, company.id, fecha, `Venta ${v.folio} ${TEST_TAG}`, v.id, "PURIF_VENTA", [
      { cuentaSAT: "1103", monto: 150, tipo: "CARGO" },
      { cuentaSAT: "4170", monto: 150, tipo: "ABONO" },
    ]);
    return v;
  });
  created.ventas.push(ventaCredito.id);

  await prisma.$transaction(async (tx) => {
    await postLegs(
      tx,
      company.id,
      fecha,
      `Cobro venta ${ventaCredito.folio} ${TEST_TAG}`,
      ventaCredito.id,
      "PURIF_VENTA_COBRADA",
      [
        { cuentaSAT: "1101", monto: 150, tipo: "CARGO" },
        { cuentaSAT: "1103", monto: 150, tipo: "ABONO" },
      ]
    );
    await tx.purifVenta.update({
      where: { id: ventaCredito.id },
      data: { estado: "COBRADA", fechaCobro: fecha, cobroFormaPago: "TRANSFERENCIA" },
    });
  });
  log(`\nVenta a crédito + cobro ${ventaCredito.folio}:`);
  const creditEntries = await assertBalanced(ventaCredito.id, ["1103", "4170", "1101"]);
  if (creditEntries.length !== 4) fail(`Expected 4 legs (venta + cobro), got ${creditEntries.length}`);

  // ── 3. Gasto de operación (recibo de luz, TRANSFERENCIA) ───────────────────
  const gasto = await prisma.$transaction(async (tx) => {
    const g = await tx.purifGasto.create({
      data: {
        companyId: company.id,
        fecha,
        categoria: "ELECTRICIDAD",
        descripcion: `Recibo CFE ${TEST_TAG}`,
        monto: 850,
        formaPago: "TRANSFERENCIA",
      },
    });
    await postLegs(tx, company.id, fecha, `Gasto purificadora ${TEST_TAG}`, g.id, "PURIF_GASTO", [
      { cuentaSAT: "5203", monto: 850, tipo: "CARGO" },
      { cuentaSAT: "1101", monto: 850, tipo: "ABONO" },
    ]);
    return g;
  });
  created.gastos.push(gasto.id);
  log(`\nGasto de operación:`);
  await assertBalanced(gasto.id, ["5203", "1101"]);

  // ── Cleanup ────────────────────────────────────────────────────────────────
  if (!KEEP) {
    await prisma.accountingEntry.deleteMany({
      where: { referencia: { in: [...created.ventas, ...created.gastos] } },
    });
    await prisma.purifVenta.deleteMany({ where: { id: { in: created.ventas } } });
    await prisma.purifGasto.deleteMany({ where: { id: { in: created.gastos } } });
    log(`\n🧹 Cleaned up test rows (set KEEP=1 to keep them).`);
  } else {
    log(`\nKEEP=1 — test rows left in place.`);
  }

  log(`\n✅ All checks passed`);
}

main()
  .catch((e) => {
    console.error("❌", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
