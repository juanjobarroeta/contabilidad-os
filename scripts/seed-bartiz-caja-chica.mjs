/**
 * Seed Bartiz's Caja Chica + the historical WhatsApp gastos Rosy sent.
 *
 * Creates (or reuses) a BankAccount with tipo=CAJA and titular="Rosy Valdez"
 * for CONSTRUCTORA BARTIZ-VERT (CBA170606FQ8), with an initial $5,000
 * top-up as a CREDITO BankTransaction.
 *
 * Then retroactively inserts the gastos Rosy sent via WhatsApp over the
 * last week so Katia can see them in the queue:
 *   - VARILLA ARENA — Jose Luis Lopez — $2,375 (PAGADO, SPEI to BANAMEX)
 *   - PSP — Lesly Flores — $4,825 (PENDIENTE)
 *   - SELLADOR — Luz Maria del Carmen — $9,228 (PENDIENTE)
 *   - 4 more from GASTOS SEMANA 1 (cash-paid out of caja chica, various)
 *
 * Idempotent: upserts by a synthetic unique (beneficiarioNombre +
 * importe + descripcion) check. Safe to re-run.
 *
 * Usage:
 *   set -a; . ./.env.local; set +a
 *   node scripts/seed-bartiz-caja-chica.mjs
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const BARTIZ_RFC = "CBA170606FQ8";

async function main() {
  console.log("\n═══ Seed Bartiz Caja Chica + WA gastos ═══\n");

  const company = await prisma.company.findUnique({
    where: { rfc: BARTIZ_RFC },
    select: { id: true, razonSocial: true },
  });
  if (!company) throw new Error("Bartiz company not found");
  console.log(`✓ Company: ${company.razonSocial}`);

  // Pick the Hacienda Ovinos proyecto for these retro-gastos
  const proyecto = await prisma.proyecto.findFirst({
    where: { companyId: company.id, codigo: { contains: "OVINOS", mode: "insensitive" } },
    select: { id: true, codigo: true, nombre: true },
  });
  if (!proyecto) throw new Error("Ovinos project not found");
  console.log(`✓ Proyecto: ${proyecto.codigo} ${proyecto.nombre}`);

  // ── 1. Ensure a CAJA bank account ─────────────────────────────────
  let caja = await prisma.bankAccount.findFirst({
    where: { companyId: company.id, tipo: "CAJA" },
  });
  if (!caja) {
    caja = await prisma.bankAccount.create({
      data: {
        companyId: company.id,
        banco: "Caja Chica",
        nombre: "Caja Chica Rosy",
        numeroCuenta: "CAJA-ROSY-01",
        moneda: "MXN",
        tipo: "CAJA",
        titular: "Rosy Valdez",
      },
    });
    console.log(`✓ Created Caja Chica BankAccount (${caja.id})`);
    console.log(`  ↳ NOTE: no synthetic top-up created. Bank movements come`);
    console.log(`          exclusively from CSV imports — Juan importa el`);
    console.log(`          estado de cuenta de la caja y los movimientos`);
    console.log(`          aparecen automáticamente.`);
  } else {
    console.log(`✓ Caja Chica already exists (${caja.id})`);
  }

  // ── 2. Ensure a main "BBVA Cheques"-style account for SPEIs ──────
  //    Use any CHEQUES account if present; otherwise create a placeholder.
  let cheques = await prisma.bankAccount.findFirst({
    where: { companyId: company.id, tipo: "CHEQUES" },
  });
  if (!cheques) {
    // Just promote the first non-CAJA account to CHEQUES
    cheques = await prisma.bankAccount.findFirst({
      where: { companyId: company.id, NOT: { tipo: "CAJA" } },
    });
    if (cheques && cheques.tipo !== "CHEQUES") {
      cheques = await prisma.bankAccount.update({
        where: { id: cheques.id },
        data: { tipo: "CHEQUES" },
      });
    }
  }
  if (!cheques) {
    cheques = await prisma.bankAccount.create({
      data: {
        companyId: company.id,
        banco: "BBVA",
        nombre: "Cuenta principal Bartiz",
        numeroCuenta: "BBVA-PLACEHOLDER-01",
        moneda: "MXN",
        tipo: "CHEQUES",
        titular: "CONSTRUCTORA BARTIZ-VERT",
      },
    });
    console.log(`✓ Created placeholder CHEQUES account (${cheques.id}) — edit details in Tesorería`);
  } else {
    console.log(`✓ CHEQUES account: ${cheques.banco} ${cheques.nombre}`);
  }

  // ── 3. Seed historical WhatsApp gastos (idempotent) ───────────────
  const week1 = new Date("2026-04-23T11:00:00");
  const rows = [
    // From PAGOS A REALIZAR table
    {
      beneficiarioNombre: "Lesly Flores",
      descripcion: "PSP (imprimación-sellador pre-pintura)",
      importe: 4825.0,
      caja: false,
      bankAccountId: cheques.id,
      estado: "PENDIENTE",
      notas: "WhatsApp — 21 abr 2026",
      createdAt: week1,
    },
    {
      beneficiarioNombre: "Luz Maria del Carmen",
      descripcion: "Sellador",
      importe: 9228.0,
      caja: false,
      bankAccountId: cheques.id,
      estado: "PENDIENTE",
      notas: "WhatsApp — 21 abr 2026",
      createdAt: week1,
    },
    {
      beneficiarioNombre: "Jose Luis Lopez Pozos",
      descripcion: "Varilla y arena",
      importe: 2375.0,
      caja: false,
      bankAccountId: cheques.id,
      estado: "PAGADO",
      pagadoAt: new Date("2026-04-23T11:06:00"),
      notas: "SPEI Banamex ref 3426520 — 23 abr 2026",
      createdAt: new Date("2026-04-23T11:00:00"),
    },
    // Placeholder rows from GASTOS SEMANA 1 — concrete breakdown pending
    {
      beneficiarioNombre: "Gastos semana 1 (caja chica)",
      descripcion: "Materiales menores + transporte — ver GASTOS SEMANA 1.pdf",
      importe: 3200.0,
      caja: true,
      bankAccountId: caja.id,
      estado: "PENDIENTE",
      notas: "Reembolso semanal Rosy — desglose viene en PDF",
      createdAt: new Date("2026-04-21T10:00:00"),
    },
  ];

  let inserted = 0;
  let skipped = 0;
  for (const row of rows) {
    const exists = await prisma.gasto.findFirst({
      where: {
        companyId: company.id,
        beneficiarioNombre: row.beneficiarioNombre,
        importe: row.importe,
        descripcion: row.descripcion,
      },
      select: { id: true },
    });
    if (exists) { skipped++; continue; }
    await prisma.gasto.create({
      data: {
        companyId: company.id,
        proyectoId: proyecto.id,
        bankAccountId: row.bankAccountId,
        beneficiarioNombre: row.beneficiarioNombre,
        descripcion: row.descripcion,
        importe: row.importe,
        caja: row.caja,
        estado: row.estado,
        pagadoAt: row.pagadoAt ?? null,
        notas: row.notas,
        createdAt: row.createdAt,
      },
    });
    inserted++;
  }
  console.log(`✓ Gastos seeded: ${inserted} new · ${skipped} existing (skipped)`);

  console.log("\n─── Summary ────────────────────────");
  console.log(`  Caja Chica:  ${caja.nombre} (titular: ${caja.titular})`);
  console.log(`  CHEQUES:     ${cheques.banco} ${cheques.nombre}`);
  console.log(`  Gastos:      ${inserted + skipped} total for Ovinos`);
  console.log();
  console.log(`Katia can open bartiz.vercel.app → Gastos to see the queue.`);
  console.log();
}

main()
  .catch((e) => {
    console.error("❌", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
