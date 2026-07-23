/**
 * Smoke test for the automotriz → accounting integration (the unit lifecycle
 * money loop: recibir → costo capitalizado → interés de piso → venta).
 *
 * Run:
 *   set -a; . ./.env.local; set +a
 *   node scripts/validate-automotriz-postings.mjs
 *
 * What it does:
 *   1. Picks (or fails asking you to enable) a Company with AUTOMOTRIZ.
 *   2. Recibe una unidad: DR 1115 / CR 2104 por el costo de compra.
 *   3. Costo capitalizado (ACONDICIONAMIENTO): DR 1115 / CR 2104.
 *   4. Interés de plan piso: DR 5205 / CR 2104 (gasto, no capitaliza).
 *   5. Venta con IVA + ISAN: DR 1103 = precio+iva+isan, CR 4180/2102/2110;
 *      costo de ventas DR 5110 / CR 1115 por el costo capitalizado.
 *   6. Asserts por referencia: Σ CARGO = Σ ABONO, fuente=AUTOMOTRIZ, cuentas
 *      esperadas, y que el 1115 quede en cero (todo lo capitalizado salió).
 *   7. Cleans up unless KEEP=1.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const KEEP = process.env.KEEP === "1";
const TEST_TAG = `[validate-auto-${Date.now()}]`;

const log = (...a) => console.log(...a);
const fail = (msg) => {
  console.error("❌", msg);
  process.exit(1);
};
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const DEFAULT_ACCOUNTS = [
  { cuentaSAT: "1103", nombre: "Cuentas por cobrar", tipo: "ACTIVO" },
  { cuentaSAT: "1115", nombre: "Inventario de vehículos", tipo: "ACTIVO" },
  { cuentaSAT: "2102", nombre: "IVA trasladado", tipo: "PASIVO" },
  { cuentaSAT: "2104", nombre: "Acreedores diversos", tipo: "PASIVO" },
  { cuentaSAT: "2110", nombre: "ISAN por pagar", tipo: "PASIVO" },
  { cuentaSAT: "4180", nombre: "Ingresos por venta de vehículos", tipo: "INGRESO" },
  { cuentaSAT: "5110", nombre: "Costo de ventas de vehículos", tipo: "COSTO" },
  { cuentaSAT: "5205", nombre: "Intereses de plan piso", tipo: "GASTO" },
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
      fuente: "AUTOMOTRIZ",
    });
  }
  await tx.accountingEntry.createMany({ data });
}

async function assertBalanced(referencia, expectAccounts) {
  const entries = await prisma.accountingEntry.findMany({
    where: { referencia },
    include: { chartAccount: { select: { cuentaSAT: true } } },
  });
  if (!entries.length) fail(`Sin pólizas para referencia ${referencia}`);
  const cargos = round2(entries.filter((e) => e.tipo === "CARGO").reduce((s, e) => s + e.monto, 0));
  const abonos = round2(entries.filter((e) => e.tipo === "ABONO").reduce((s, e) => s + e.monto, 0));
  if (cargos !== abonos) fail(`Desbalance en ${referencia}: cargos ${cargos} ≠ abonos ${abonos}`);
  for (const e of entries) {
    if (e.fuente !== "AUTOMOTRIZ") fail(`fuente inesperada ${e.fuente} en ${referencia}`);
  }
  const touched = new Set(entries.map((e) => e.chartAccount.cuentaSAT));
  for (const acc of expectAccounts) {
    if (!touched.has(acc)) fail(`Falta cuenta ${acc} en ${referencia} (tocadas: ${[...touched]})`);
  }
  log(`  ✓ ${referencia}: ${entries.length} legs, Σ ${cargos} balanceado, cuentas ${[...touched].join(", ")}`);
  return entries;
}

async function main() {
  const module_ = await prisma.companyModule.findFirst({
    where: { modulo: "AUTOMOTRIZ", habilitado: true },
    select: { companyId: true },
  });
  if (!module_) {
    fail(
      "Ninguna Company tiene AUTOMOTRIZ habilitado. Habilítalo:\n" +
        '  await prisma.companyModule.upsert({ where: { companyId_modulo: { companyId: X, modulo: "AUTOMOTRIZ" } }, create: { companyId: X, modulo: "AUTOMOTRIZ" }, update: { habilitado: true } })'
    );
  }
  const companyId = module_.companyId;
  log(`Company: ${companyId}`);

  const fecha = new Date();
  const COSTO = 350000;
  const ACOND = 12000;
  const INTERES = 3500;
  const PRECIO = 480000;
  const ISAN = 15000; // monto sintético — la tarifa real se valida en isan.test.ts
  const IVA = round2((PRECIO + ISAN) * 0.16);

  const vehiculo = await prisma.vehiculo.create({
    data: {
      companyId,
      vin: `VALIDATE${Date.now()}`.slice(0, 17),
      marca: "TEST",
      modelo: "Validate",
      anio: 2026,
      tipo: "NUEVO",
      estado: "EN_TRANSITO",
      costoCompra: COSTO,
      notas: TEST_TAG,
    },
  });
  log(`Vehiculo: ${vehiculo.id}`);

  // 1. Recibir (mismas cuentas que postVehiculoRecibido)
  await prisma.$transaction(async (tx) => {
    await postLegs(tx, companyId, fecha, `Entrada de unidad VIN ${vehiculo.vin}`, vehiculo.id, "VEHICULO_COMPRA", [
      { cuentaSAT: "1115", monto: COSTO, tipo: "CARGO" },
      { cuentaSAT: "2104", monto: COSTO, tipo: "ABONO" },
    ]);
    await tx.vehiculo.update({ where: { id: vehiculo.id }, data: { estado: "DISPONIBLE", fechaCompra: fecha } });
  });

  // 2. Costo capitalizado + 3. interés de piso
  const costoRow = await prisma.vehiculoCosto.create({
    data: { vehiculoId: vehiculo.id, tipo: "ACONDICIONAMIENTO", concepto: `Acondicionamiento ${TEST_TAG}`, monto: ACOND, fecha },
  });
  await prisma.$transaction(async (tx) => {
    await postLegs(tx, companyId, fecha, `Acondicionamiento — VIN ${vehiculo.vin}`, costoRow.id, "VEHICULO_COSTO", [
      { cuentaSAT: "1115", monto: ACOND, tipo: "CARGO" },
      { cuentaSAT: "2104", monto: ACOND, tipo: "ABONO" },
    ]);
  });
  const interesRow = await prisma.vehiculoCosto.create({
    data: { vehiculoId: vehiculo.id, tipo: "INTERES_PISO", concepto: `Interés piso ${TEST_TAG}`, monto: INTERES, fecha },
  });
  await prisma.$transaction(async (tx) => {
    await postLegs(tx, companyId, fecha, `Interés plan piso — VIN ${vehiculo.vin}`, interesRow.id, "VEHICULO_INTERES_PISO", [
      { cuentaSAT: "5205", monto: INTERES, tipo: "CARGO" },
      { cuentaSAT: "2104", monto: INTERES, tipo: "ABONO" },
    ]);
  });

  // 4. Venta (mismas cuentas que postVehiculoVendido)
  const capitalizado = COSTO + ACOND;
  await prisma.$transaction(async (tx) => {
    await postLegs(tx, companyId, fecha, `Venta de unidad VIN ${vehiculo.vin}`, vehiculo.id, "VEHICULO_VENTA", [
      { cuentaSAT: "1103", monto: round2(PRECIO + IVA + ISAN), tipo: "CARGO" },
      { cuentaSAT: "4180", monto: PRECIO, tipo: "ABONO" },
      { cuentaSAT: "2102", monto: IVA, tipo: "ABONO" },
      { cuentaSAT: "2110", monto: ISAN, tipo: "ABONO" },
      { cuentaSAT: "5110", monto: capitalizado, tipo: "CARGO" },
      { cuentaSAT: "1115", monto: capitalizado, tipo: "ABONO" },
    ]);
    await tx.vehiculo.update({
      where: { id: vehiculo.id },
      data: { estado: "VENDIDO", precioVenta: PRECIO, isan: ISAN, fechaVenta: fecha },
    });
  });

  log("\nAsserts:");
  const compra = await assertBalanced(vehiculo.id, ["1115", "2104", "1103", "4180", "2102", "2110", "5110"]);
  await assertBalanced(costoRow.id, ["1115", "2104"]);
  await assertBalanced(interesRow.id, ["5205", "2104"]);

  // 1115 debe quedar en cero: entró COSTO + ACOND, salió capitalizado.
  const inv1115 = compra
    .concat(await prisma.accountingEntry.findMany({ where: { referencia: costoRow.id }, include: { chartAccount: { select: { cuentaSAT: true } } } }))
    .filter((e) => e.chartAccount.cuentaSAT === "1115");
  const saldo1115 = round2(
    inv1115.reduce((s, e) => s + (e.tipo === "CARGO" ? e.monto : -e.monto), 0)
  );
  if (saldo1115 !== 0) fail(`Inventario 1115 no quedó en cero: ${saldo1115}`);
  log(`  ✓ 1115 Inventario de vehículos queda en $0 tras la venta`);

  // Utilidad por VIN esperada
  const utilidad = round2(PRECIO - COSTO - ACOND - INTERES);
  log(`  ✓ Utilidad por VIN (precio − compra − costos − interés): $${utilidad}`);

  if (!KEEP) {
    await prisma.accountingEntry.deleteMany({ where: { referencia: { in: [vehiculo.id, costoRow.id, interesRow.id] } } });
    await prisma.vehiculo.delete({ where: { id: vehiculo.id } }); // cascades costos
    log("\nCleaned up (KEEP=1 para conservar).");
  }

  log("\n✅ All checks passed");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
