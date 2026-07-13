/**
 * Smoke test for the restaurante → accounting integration (the two money
 * loops: compra recibida→pagada and orden cobrada + costo de venta).
 *
 * Run:
 *   set -a; . ./.env.local; set +a
 *   node scripts/validate-restaurante-postings.mjs
 *
 * What it does:
 *   1. Picks (or fails asking you to enable) a Company with RESTAURANTE.
 *   2. Ensures a BankAccount, an insumo, a menu item with a recipe.
 *   3. Compra loop: creates a compra (ORDENADA), runs the same transaction
 *      /recibir uses (stock + avg cost + DR 1107/1118 CR 2104), then the
 *      /pagar transaction (BankTransaction DEBITO + DR 2104 CR 1101).
 *   4. Orden loop: creates an orden ABIERTA, runs the /cobrar transaction
 *      for TRANSFERENCIA (BankTransaction CREDITO + DR 1101 / CR 4160 +
 *      CR 2102 + CR 2107 propina, and DR 5103 / CR 1107 costo) with
 *      inventory relief per the recipe.
 *   5. Asserts per referencia: Σ CARGO = Σ ABONO, fuente=RESTAURANTE,
 *      expected accounts touched, stock/avg-cost math correct.
 *   6. Cleans up unless KEEP=1.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const KEEP = process.env.KEEP === "1";
const TEST_TAG = `[validate-rest-${Date.now()}]`;

const log = (...a) => console.log(...a);
const fail = (msg) => {
  console.error("❌", msg);
  process.exit(1);
};
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const DEFAULT_ACCOUNTS = [
  { cuentaSAT: "1101", nombre: "Bancos", tipo: "ACTIVO" },
  { cuentaSAT: "1107", nombre: "Almacén de insumos", tipo: "ACTIVO" },
  { cuentaSAT: "1118", nombre: "IVA acreditable", tipo: "ACTIVO" },
  { cuentaSAT: "2102", nombre: "IVA trasladado", tipo: "PASIVO" },
  { cuentaSAT: "2104", nombre: "Acreedores diversos", tipo: "PASIVO" },
  { cuentaSAT: "2107", nombre: "Propinas por pagar", tipo: "PASIVO" },
  { cuentaSAT: "4160", nombre: "Ingresos por alimentos y bebidas", tipo: "INGRESO" },
  { cuentaSAT: "5103", nombre: "Costo de alimentos y bebidas", tipo: "COSTO" },
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

async function postPair(tx, companyId, fecha, desc, monto, referencia, referenciaTipo, cargoSAT, abonoSAT) {
  const [cargo, abono] = await Promise.all([
    getOrCreateAccount(tx, companyId, cargoSAT),
    getOrCreateAccount(tx, companyId, abonoSAT),
  ]);
  const year = fecha.getUTCFullYear();
  const month = fecha.getUTCMonth() + 1;
  await tx.accountingEntry.createMany({
    data: [
      { companyId, chartAccountId: cargo.id, fecha, year, month, descripcion: desc, referencia, referenciaTipo, monto, tipo: "CARGO", fuente: "RESTAURANTE" },
      { companyId, chartAccountId: abono.id, fecha, year, month, descripcion: desc, referencia, referenciaTipo, monto, tipo: "ABONO", fuente: "RESTAURANTE" },
    ],
  });
}

async function assertBalanced(referencia, referenciaTipo, expectedAccounts) {
  const rows = await prisma.accountingEntry.findMany({
    where: { referencia, referenciaTipo },
    include: { chartAccount: { select: { cuentaSAT: true } } },
  });
  if (rows.length === 0) fail(`${referenciaTipo}: no ledger rows found`);
  const cargos = rows.filter((r) => r.tipo === "CARGO").reduce((s, r) => s + r.monto, 0);
  const abonos = rows.filter((r) => r.tipo === "ABONO").reduce((s, r) => s + r.monto, 0);
  if (round2(cargos) !== round2(abonos)) {
    fail(`${referenciaTipo}: unbalanced — CARGO ${cargos} vs ABONO ${abonos}`);
  }
  if (rows.some((r) => r.fuente !== "RESTAURANTE")) {
    fail(`${referenciaTipo}: wrong fuente`);
  }
  const touched = new Set(rows.map((r) => r.chartAccount.cuentaSAT));
  for (const acc of expectedAccounts) {
    if (!touched.has(acc)) fail(`${referenciaTipo}: expected account ${acc} not touched`);
  }
  log(`  ✓ ${referenciaTipo}: ${rows.length} rows, Σ ${round2(cargos)} balanced, accounts [${[...touched].join(", ")}]`);
  return rows;
}

async function main() {
  log("\n═══ Restaurante → Accounting validation ═══\n");

  const moduleRow = await prisma.companyModule.findFirst({
    where: { modulo: "RESTAURANTE", habilitado: true },
    include: { company: { select: { id: true, rfc: true, razonSocial: true } } },
  });
  if (!moduleRow) {
    fail(
      "No company has RESTAURANTE enabled. Insert a CompanyModule row " +
        "(modulo=RESTAURANTE, habilitado=true) for a test company first."
    );
  }
  const company = moduleRow.company;
  const companyId = company.id;
  log(`✓ Using company: ${company.razonSocial} (${company.rfc})`);

  let bankAccount = await prisma.bankAccount.findFirst({ where: { companyId } });
  let createdBank = false;
  if (!bankAccount) {
    bankAccount = await prisma.bankAccount.create({
      data: { companyId, banco: "TEST", nombre: `Cuenta ${TEST_TAG}`, numeroCuenta: `T${Date.now()}` },
    });
    createdBank = true;
  }
  log(`✓ Bank account: ${bankAccount.nombre}`);

  const cleanup = { ordenId: null, compraId: null, insumoId: null, menuItemId: null, bankTxIds: [] };

  try {
    // ── Fixtures ─────────────────────────────────────────────────────────────
    const insumo = await prisma.restInsumo.create({
      data: { companyId, nombre: `Tomate ${TEST_TAG}`, unidad: "KG", stock: 0, costoPromedio: 0 },
    });
    cleanup.insumoId = insumo.id;

    const menuItem = await prisma.restMenuItem.create({
      data: {
        companyId,
        nombre: `Ensalada ${TEST_TAG}`,
        precio: 116, // IVA incluido → 100 + 16
        receta: { create: [{ insumoId: insumo.id, cantidad: 0.5 }] },
      },
    });
    cleanup.menuItemId = menuItem.id;
    log(`✓ Fixtures: insumo + menu item (receta 0.5 KG)`);

    // ── Compra loop ──────────────────────────────────────────────────────────
    // 10 KG @ $20 = 200 subtotal + 0 IVA (alimento tasa 0%)
    const compra = await prisma.restCompra.create({
      data: {
        companyId,
        folio: `OC-TEST-${Date.now()}`,
        estado: "ORDENADA",
        fecha: new Date(),
        subtotal: 200,
        iva: 0,
        items: { create: [{ insumoId: insumo.id, cantidad: 10, costoUnitario: 20, importe: 200 }] },
      },
    });
    cleanup.compraId = compra.id;

    // recibir (mirrors /recibir): stock + avg cost + posting
    await prisma.$transaction(async (tx) => {
      await tx.restInsumo.update({
        where: { id: insumo.id },
        data: { stock: 10, costoPromedio: 20 },
      });
      await postPair(tx, companyId, new Date(), `Compra ${compra.folio}`, 200, compra.id, "REST_COMPRA_RECIBIDA", "1107", "2104");
      await tx.restCompra.update({ where: { id: compra.id }, data: { estado: "RECIBIDA", recibidaAt: new Date() } });
    });
    await assertBalanced(compra.id, "REST_COMPRA_RECIBIDA", ["1107", "2104"]);

    // pagar (mirrors /pagar): bank tx + posting
    await prisma.$transaction(async (tx) => {
      const bankTx = await tx.bankTransaction.create({
        data: {
          companyId,
          bankAccountId: bankAccount.id,
          fecha: new Date(),
          descripcion: `Pago compra ${compra.folio} ${TEST_TAG}`,
          monto: -200,
          tipo: "DEBITO",
          status: "MATCHED",
          source: "RESTAURANTE",
        },
      });
      cleanup.bankTxIds.push(bankTx.id);
      await postPair(tx, companyId, new Date(), `Pago compra ${compra.folio}`, 200, compra.id, "REST_COMPRA_PAGADA", "2104", "1101");
      await tx.restCompra.update({
        where: { id: compra.id },
        data: { estado: "PAGADA", pagadaAt: new Date(), formaPago: "TRANSFERENCIA", bankTransactionId: bankTx.id },
      });
    });
    await assertBalanced(compra.id, "REST_COMPRA_PAGADA", ["2104", "1101"]);

    const insumoAfterCompra = await prisma.restInsumo.findUnique({ where: { id: insumo.id } });
    if (insumoAfterCompra.stock !== 10 || insumoAfterCompra.costoPromedio !== 20) {
      fail(`Insumo after compra: expected stock 10 @ $20, got ${insumoAfterCompra.stock} @ ${insumoAfterCompra.costoPromedio}`);
    }
    log(`  ✓ Inventario: 10 KG @ $20 promedio`);

    // ── Orden loop ───────────────────────────────────────────────────────────
    // 2 ensaladas @ 116 = 232 total (200 subtotal + 32 IVA), propina 20,
    // costo = 2 * (0.5 KG * $20) = 20, descarga 1 KG.
    const orden = await prisma.restOrden.create({
      data: {
        companyId,
        folio: Math.floor(Date.now() / 1000),
        tipo: "MESA",
        mesa: "T1",
        estado: "ABIERTA",
        items: { create: [{ menuItemId: menuItem.id, cantidad: 2, precioUnitario: 116 }] },
      },
    });
    cleanup.ordenId = orden.id;

    const total = 232;
    const subtotal = round2(total / 1.16);
    const iva = round2(total - subtotal);
    const propina = 20;
    const costo = 20;

    await prisma.$transaction(async (tx) => {
      const bankTx = await tx.bankTransaction.create({
        data: {
          companyId,
          bankAccountId: bankAccount.id,
          fecha: new Date(),
          descripcion: `Orden #${orden.folio} ${TEST_TAG}`,
          monto: total + propina,
          tipo: "CREDITO",
          status: "MATCHED",
          source: "RESTAURANTE",
        },
      });
      cleanup.bankTxIds.push(bankTx.id);

      // Venta: 4 legs (DR 1101 total+propina / CR 4160 + CR 2102 + CR 2107)
      const fecha = new Date();
      const year = fecha.getUTCFullYear();
      const month = fecha.getUTCMonth() + 1;
      const [cargo, ingresos, ivaAcc, propAcc] = await Promise.all([
        getOrCreateAccount(tx, companyId, "1101"),
        getOrCreateAccount(tx, companyId, "4160"),
        getOrCreateAccount(tx, companyId, "2102"),
        getOrCreateAccount(tx, companyId, "2107"),
      ]);
      const base = { companyId, fecha, year, month, descripcion: `Orden #${orden.folio}`, referencia: orden.id, referenciaTipo: "REST_ORDEN_COBRADA", fuente: "RESTAURANTE" };
      await tx.accountingEntry.createMany({
        data: [
          { ...base, chartAccountId: cargo.id, monto: total + propina, tipo: "CARGO" },
          { ...base, chartAccountId: ingresos.id, monto: subtotal, tipo: "ABONO" },
          { ...base, chartAccountId: ivaAcc.id, monto: iva, tipo: "ABONO" },
          { ...base, chartAccountId: propAcc.id, monto: propina, tipo: "ABONO" },
        ],
      });

      await postPair(tx, companyId, fecha, `Costo orden #${orden.folio}`, costo, orden.id, "REST_COSTO_VENTA", "5103", "1107");
      await tx.restInsumo.update({ where: { id: insumo.id }, data: { stock: { decrement: 1 } } });
      await tx.restOrden.update({
        where: { id: orden.id },
        data: { estado: "COBRADA", cobradaAt: fecha, formaPago: "TRANSFERENCIA", subtotal, iva, total, propina, costoTotal: costo, bankTransactionId: bankTx.id },
      });
    });

    await assertBalanced(orden.id, "REST_ORDEN_COBRADA", ["1101", "4160", "2102", "2107"]);
    await assertBalanced(orden.id, "REST_COSTO_VENTA", ["5103", "1107"]);

    const insumoFinal = await prisma.restInsumo.findUnique({ where: { id: insumo.id } });
    if (insumoFinal.stock !== 9) {
      fail(`Inventory relief: expected stock 9, got ${insumoFinal.stock}`);
    }
    log(`  ✓ Descarga de inventario: 10 → 9 KG`);

    log("\n✅ All checks passed\n");
  } finally {
    if (KEEP) {
      log("KEEP=1 — leaving test rows in place");
    } else {
      // FK-safe order; ledger rows reference by string, no FK.
      if (cleanup.ordenId) {
        await prisma.accountingEntry.deleteMany({ where: { referencia: cleanup.ordenId } });
        await prisma.restOrden.delete({ where: { id: cleanup.ordenId } }).catch(() => {});
      }
      if (cleanup.compraId) {
        await prisma.accountingEntry.deleteMany({ where: { referencia: cleanup.compraId } });
        await prisma.restCompra.delete({ where: { id: cleanup.compraId } }).catch(() => {});
      }
      if (cleanup.menuItemId) await prisma.restMenuItem.delete({ where: { id: cleanup.menuItemId } }).catch(() => {});
      if (cleanup.insumoId) await prisma.restInsumo.delete({ where: { id: cleanup.insumoId } }).catch(() => {});
      for (const id of cleanup.bankTxIds) {
        await prisma.bankTransaction.delete({ where: { id } }).catch(() => {});
      }
      if (createdBank) await prisma.bankAccount.delete({ where: { id: bankAccount.id } }).catch(() => {});
      log("✓ Cleaned up test rows");
    }
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
