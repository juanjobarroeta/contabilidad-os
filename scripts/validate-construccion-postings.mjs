/**
 * Smoke test for the construction → accounting integration.
 *
 * Replicates exactly what POST /api/construccion/solicitudes-compra/:id/pagar
 * does, but as a one-shot Node script — no auth, no HTTP, no dev server.
 *
 * Run:
 *   set -a; . ./.env.local; set +a
 *   node scripts/validate-construccion-postings.mjs
 *
 * What it does:
 *   1. Picks (or creates) a Company with the CONSTRUCCION module enabled.
 *   2. Ensures a BankAccount, a Proyecto, a SolicitudCompra (APROBADA) exist.
 *   3. Runs the same Prisma transaction the /pagar route uses:
 *        - inserts a BankTransaction (DEBITO)
 *        - posts a balanced ledger pair (DR 5101 / CR 1101)
 *        - flips the solicitud to PAGADA + links the bank tx
 *   4. Reads back the AccountingEntry rows and the balance check (Σcargo == Σabono).
 *   5. Cleans up the test data unless KEEP=1.
 *
 * Exits 0 on success, 1 on any check failing.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const KEEP = process.env.KEEP === "1";
const TEST_TAG = `[validate-construccion-${Date.now()}]`;

const log = (...a) => console.log(...a);
const fail = (msg) => {
  console.error("❌", msg);
  process.exit(1);
};

// ── Default chart-of-accounts the postings helper auto-creates ──────────────
const DEFAULT_ACCOUNTS = [
  { cuentaSAT: "1101", nombre: "Bancos",                tipo: "ACTIVO"  },
  { cuentaSAT: "5101", nombre: "Costo de obra",         tipo: "COSTO"   },
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
    data: { companyId, cuentaSAT, nombre: def.nombre, tipo: def.tipo },
    select: { id: true },
  });
}

async function main() {
  log("\n═══ Construction → Accounting validation ═══\n");

  // ── 1. Find a Company with CONSTRUCCION enabled ───────────────────────────
  const moduleRow = await prisma.companyModule.findFirst({
    where: { modulo: "CONSTRUCCION", habilitado: true },
    include: { company: { select: { id: true, rfc: true, razonSocial: true } } },
  });

  if (!moduleRow) {
    fail(
      "No company has CONSTRUCCION enabled. Either run `npm run db:seed` " +
        "or insert a CompanyModule row manually for an existing company."
    );
  }
  const company = moduleRow.company;
  log(`✓ Using company: ${company.razonSocial} (${company.rfc})`);

  // ── 2. Ensure a BankAccount ───────────────────────────────────────────────
  let bankAccount = await prisma.bankAccount.findFirst({
    where: { companyId: company.id },
  });
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
    log(`✓ Reusing existing bank account ${bankAccount.id}`);
  }

  // ── 3. Create test Proyecto ───────────────────────────────────────────────
  const proyecto = await prisma.proyecto.create({
    data: {
      companyId: company.id,
      codigo: `OBR-VALIDATE-${Date.now()}`,
      nombre: `${TEST_TAG} Proyecto de validación`,
      tipo: "PRIVADO",
    },
  });
  log(`✓ Created proyecto ${proyecto.codigo}`);

  // ── 4. Create solicitud in APROBADA state ─────────────────────────────────
  const TOTAL = 12345.67;
  const solicitud = await prisma.solicitudCompra.create({
    data: {
      companyId: company.id,
      proyectoId: proyecto.id,
      folio: `SC-VAL-${Date.now()}`,
      estado: "APROBADA",
      aprobadaAt: new Date(),
      total: TOTAL,
      partidas: {
        create: [
          {
            descripcion: "Cemento Portland CPC 30R",
            cantidad: 10,
            precioUnitario: 234.567,
            importe: 2345.67,
          },
          {
            descripcion: "Acero corrugado 3/8\"",
            cantidad: 100,
            precioUnitario: 100,
            importe: 10000,
          },
        ],
      },
    },
  });
  log(`✓ Created solicitud ${solicitud.folio}, total=${TOTAL}`);

  // ── 5. The proof: atomic /pagar flow ──────────────────────────────────────
  const fecha = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const bankTx = await tx.bankTransaction.create({
      data: {
        companyId: solicitud.companyId,
        bankAccountId: bankAccount.id,
        fecha,
        descripcion: `Pago solicitud ${solicitud.folio}`,
        referencia: solicitud.folio,
        monto: -Math.abs(solicitud.total),
        tipo: "DEBITO",
        status: "MATCHED",
        source: "UPLOAD",
        notes: `${TEST_TAG} validation script`,
      },
    });

    // Inline of postSolicitudCompraPaid → postBalancedEntry
    const [cargoAcc, abonoAcc] = await Promise.all([
      getOrCreateAccount(tx, solicitud.companyId, "5101"),
      getOrCreateAccount(tx, solicitud.companyId, "1101"),
    ]);

    await tx.accountingEntry.createMany({
      data: [
        {
          companyId: solicitud.companyId,
          chartAccountId: cargoAcc.id,
          fecha,
          descripcion: `Pago solicitud ${solicitud.folio} — proyecto ${proyecto.codigo}`,
          referencia: solicitud.id,
          referenciaTipo: "SOLICITUD_COMPRA",
          monto: solicitud.total,
          tipo: "CARGO",
          fuente: "CONSTRUCCION",
        },
        {
          companyId: solicitud.companyId,
          chartAccountId: abonoAcc.id,
          fecha,
          descripcion: `Pago solicitud ${solicitud.folio} — proyecto ${proyecto.codigo}`,
          referencia: solicitud.id,
          referenciaTipo: "SOLICITUD_COMPRA",
          monto: solicitud.total,
          tipo: "ABONO",
          fuente: "CONSTRUCCION",
        },
      ],
    });

    const updated = await tx.solicitudCompra.update({
      where: { id: solicitud.id },
      data: {
        estado: "PAGADA",
        pagadaAt: fecha,
        bankTransactionId: bankTx.id,
      },
    });

    return { bankTx, solicitud: updated };
  });

  log(`✓ Atomic transaction committed`);

  // ── 6. Read back and verify ───────────────────────────────────────────────
  const entries = await prisma.accountingEntry.findMany({
    where: { referencia: solicitud.id, referenciaTipo: "SOLICITUD_COMPRA" },
    include: { chartAccount: { select: { cuentaSAT: true, nombre: true } } },
    orderBy: { tipo: "asc" },
  });

  if (entries.length !== 2) fail(`Expected 2 ledger rows, got ${entries.length}`);

  const cargo = entries.find((e) => e.tipo === "CARGO");
  const abono = entries.find((e) => e.tipo === "ABONO");
  if (!cargo || !abono) fail("Missing CARGO or ABONO row");
  if (cargo.monto !== abono.monto) fail(`Unbalanced: ${cargo.monto} vs ${abono.monto}`);
  if (cargo.chartAccount.cuentaSAT !== "5101") fail(`Cargo account is ${cargo.chartAccount.cuentaSAT}, expected 5101`);
  if (abono.chartAccount.cuentaSAT !== "1101") fail(`Abono account is ${abono.chartAccount.cuentaSAT}, expected 1101`);
  if (cargo.fuente !== "CONSTRUCCION") fail(`fuente is ${cargo.fuente}, expected CONSTRUCCION`);

  if (result.solicitud.estado !== "PAGADA") fail(`Solicitud estado is ${result.solicitud.estado}, expected PAGADA`);
  if (result.solicitud.bankTransactionId !== result.bankTx.id) fail("bankTransactionId not linked");

  log("\n─── Ledger rows ─────────────────────────────────────");
  for (const e of entries) {
    log(
      `  ${e.tipo.padEnd(5)}  ${e.chartAccount.cuentaSAT}  ${e.chartAccount.nombre.padEnd(20)}  ${e.monto.toFixed(2)}  → ${e.descripcion}`
    );
  }
  log("─────────────────────────────────────────────────────\n");

  log("✅ All checks passed:");
  log("   • BankTransaction created (negative monto, MATCHED)");
  log("   • Balanced ledger pair posted (DR 5101 = CR 1101)");
  log("   • SolicitudCompra → PAGADA, linked to BankTx");
  log("   • Provenance: fuente=CONSTRUCCION, referenciaTipo=SOLICITUD_COMPRA\n");

  // ── 7. Cleanup ────────────────────────────────────────────────────────────
  if (KEEP) {
    log(`(Keeping test data — re-run with KEEP=0 or unset to clean up.)\n`);
    log(`   Proyecto:    ${proyecto.id}`);
    log(`   Solicitud:   ${solicitud.id}`);
    log(`   BankTx:      ${result.bankTx.id}`);
    return;
  }

  await prisma.$transaction([
    prisma.accountingEntry.deleteMany({ where: { referencia: solicitud.id, referenciaTipo: "SOLICITUD_COMPRA" } }),
    prisma.solicitudCompra.delete({ where: { id: solicitud.id } }),
    prisma.bankTransaction.delete({ where: { id: result.bankTx.id } }),
    prisma.proyecto.delete({ where: { id: proyecto.id } }),
  ]);
  log("✓ Cleaned up test data\n");
}

main()
  .catch((e) => {
    console.error("❌ Validation failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
