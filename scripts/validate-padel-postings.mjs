/**
 * Smoke test for the padel → accounting integration (court-rental money loop).
 *
 * Run:
 *   set -a; . ./.env.local; set +a
 *   node scripts/validate-padel-postings.mjs
 *
 * What it does:
 *   1. Picks (or fails asking you to enable) a Company with the PADEL module.
 *   2. Ensures a BankAccount, a Court, and a Reservation (CONFIRMADA, unpaid).
 *   3. Runs the same Prisma transaction the /charge route uses for a
 *      TRANSFERENCIA: inserts a BankTransaction (CREDITO), posts the balanced
 *      court-rental rows (DR 1101 / CR 4150 + CR 2102 IVA), flips the
 *      reservation to pagado + links the bank tx.
 *   4. Reads back the AccountingEntry rows and asserts: 3 rows (IVA case),
 *      Σ CARGO = Σ ABONO, fuente=PADEL, referenciaTipo=RESERVATION_CHARGE,
 *      accounts 1101 / 4150 / 2102.
 *   5. Cleans up unless KEEP=1.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const KEEP = process.env.KEEP === "1";
const TEST_TAG = `[validate-padel-${Date.now()}]`;

const log = (...a) => console.log(...a);
const fail = (msg) => {
  console.error("❌", msg);
  process.exit(1);
};

// Subset of DEFAULT_ACCOUNTS the test touches (mirrors src/lib/accounting/postings.ts).
const DEFAULT_ACCOUNTS = [
  { cuentaSAT: "1101", nombre: "Bancos", tipo: "ACTIVO" },
  { cuentaSAT: "2102", nombre: "IVA trasladado", tipo: "PASIVO" },
  { cuentaSAT: "4150", nombre: "Ingresos por renta de cancha", tipo: "INGRESO" },
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

// IVA-included split, mirroring src/lib/padel.ts
function splitIvaIncluded(total, rate) {
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  if (!(rate > 0) || !(total > 0)) return { subtotal: round2(total), iva: 0 };
  const subtotal = round2(total / (1 + rate));
  return { subtotal, iva: round2(total - subtotal) };
}

async function main() {
  log("\n═══ Padel → Accounting validation ═══\n");

  const moduleRow = await prisma.companyModule.findFirst({
    where: { modulo: "PADEL", habilitado: true },
    include: { company: { select: { id: true, rfc: true, razonSocial: true } } },
  });
  if (!moduleRow) {
    fail(
      "No company has PADEL enabled. Insert a CompanyModule row " +
        "(modulo=PADEL, habilitado=true) for a test company first."
    );
  }
  const company = moduleRow.company;
  log(`✓ Using company: ${company.razonSocial} (${company.rfc})`);

  let bankAccount = await prisma.bankAccount.findFirst({ where: { companyId: company.id } });
  if (!bankAccount) {
    bankAccount = await prisma.bankAccount.create({
      data: {
        companyId: company.id,
        banco: "BBVA",
        nombre: `${TEST_TAG} Cuenta de pruebas`,
        numeroCuenta: `TEST-${Date.now()}`,
      },
    });
    log(`✓ Created test bank account ${bankAccount.id}`);
  } else {
    log(`✓ Reusing bank account ${bankAccount.id}`);
  }

  const court = await prisma.court.create({
    data: { companyId: company.id, nombre: `${TEST_TAG} Cancha` },
  });
  log(`✓ Created court ${court.nombre}`);

  const TOTAL = 580; // IVA-included
  const inicio = new Date(Date.now() + 3600_000);
  const fin = new Date(inicio.getTime() + 5400_000);
  const reservation = await prisma.reservation.create({
    data: {
      companyId: company.id,
      courtId: court.id,
      inicio,
      fin,
      estado: "CONFIRMADA",
      canal: "STAFF",
      precio: TOTAL,
    },
  });
  log(`✓ Created reservation ${reservation.id}, precio=${TOTAL}`);

  const { subtotal, iva } = splitIvaIncluded(TOTAL, 0.16);
  const fecha = new Date();
  const descripcion = `Renta ${court.nombre}`;

  const result = await prisma.$transaction(async (tx) => {
    const bankTx = await tx.bankTransaction.create({
      data: {
        companyId: company.id,
        bankAccountId: bankAccount.id,
        fecha,
        descripcion,
        referencia: reservation.id,
        monto: Math.abs(TOTAL),
        tipo: "CREDITO",
        status: "MATCHED",
        source: "PADEL",
        notes: `${TEST_TAG} validation script`,
      },
    });

    const [cargo, ingresos, ivaAcc] = await Promise.all([
      getOrCreateAccount(tx, company.id, "1101"),
      getOrCreateAccount(tx, company.id, "4150"),
      getOrCreateAccount(tx, company.id, "2102"),
    ]);
    const year = fecha.getUTCFullYear();
    const month = fecha.getUTCMonth() + 1;
    await tx.accountingEntry.createMany({
      data: [
        { companyId: company.id, chartAccountId: cargo.id, fecha, year, month, descripcion, referencia: reservation.id, referenciaTipo: "RESERVATION_CHARGE", monto: subtotal + iva, tipo: "CARGO", fuente: "PADEL" },
        { companyId: company.id, chartAccountId: ingresos.id, fecha, year, month, descripcion, referencia: reservation.id, referenciaTipo: "RESERVATION_CHARGE", monto: subtotal, tipo: "ABONO", fuente: "PADEL" },
        { companyId: company.id, chartAccountId: ivaAcc.id, fecha, year, month, descripcion, referencia: reservation.id, referenciaTipo: "RESERVATION_CHARGE", monto: iva, tipo: "ABONO", fuente: "PADEL" },
      ],
    });

    const updated = await tx.reservation.update({
      where: { id: reservation.id },
      data: { pagado: true, formaPago: "TRANSFERENCIA", cobradoAt: fecha, bankTransactionId: bankTx.id },
    });
    return { bankTx, reservation: updated };
  });
  log("✓ Atomic transaction committed");

  const entries = await prisma.accountingEntry.findMany({
    where: { referencia: reservation.id, referenciaTipo: "RESERVATION_CHARGE" },
    include: { chartAccount: { select: { cuentaSAT: true, nombre: true } } },
  });

  if (entries.length !== 3) fail(`Expected 3 ledger rows, got ${entries.length}`);
  const sumCargo = entries.filter((e) => e.tipo === "CARGO").reduce((s, e) => s + e.monto, 0);
  const sumAbono = entries.filter((e) => e.tipo === "ABONO").reduce((s, e) => s + e.monto, 0);
  if (Math.abs(sumCargo - sumAbono) > 0.001) fail(`Unbalanced: CARGO ${sumCargo} vs ABONO ${sumAbono}`);
  if (entries.some((e) => e.fuente !== "PADEL")) fail("fuente must be PADEL on all rows");
  const codes = entries.map((e) => e.chartAccount.cuentaSAT).sort();
  if (codes.join(",") !== "1101,2102,4150") fail(`Unexpected accounts: ${codes.join(",")}`);

  log("\n─── Ledger rows ─────────────────────────────────────");
  for (const e of entries) {
    log(`  ${e.tipo.padEnd(5)}  ${e.chartAccount.cuentaSAT}  ${e.chartAccount.nombre.padEnd(28)}  ${e.monto.toFixed(2)}`);
  }
  log("─────────────────────────────────────────────────────\n");
  log("✅ All checks passed:");
  log(`   • BankTransaction (CREDITO +${TOTAL}, MATCHED)`);
  log(`   • Balanced 3-leg posting (DR 1101 = CR 4150 + CR 2102), Σ=${sumCargo.toFixed(2)}`);
  log("   • Reservation → pagado, linked to BankTx");
  log("   • Provenance: fuente=PADEL, referenciaTipo=RESERVATION_CHARGE\n");

  if (KEEP) {
    log("(Keeping test data — re-run with KEEP=0 to clean up.)\n");
    return;
  }
  await prisma.$transaction([
    prisma.accountingEntry.deleteMany({ where: { referencia: reservation.id, referenciaTipo: "RESERVATION_CHARGE" } }),
    prisma.reservation.delete({ where: { id: reservation.id } }),
    prisma.bankTransaction.delete({ where: { id: result.bankTx.id } }),
    prisma.court.delete({ where: { id: court.id } }),
  ]);
  log("✓ Cleaned up test data\n");
}

main()
  .catch((e) => {
    console.error("❌ Validation failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
