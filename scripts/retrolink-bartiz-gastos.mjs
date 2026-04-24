/**
 * Retro-link the three already-paid Bartiz gastos to their insumos
 * + backfill the Jose Luis SPEI that my earlier seed marked PAGADO
 * without creating a BankTransaction.
 *
 * After this runs:
 *   - Lesly PSP $4,825   → Insumo CEMFLEX (Sikatop Seal 107)
 *   - Luz María Sellador $9,228 → Insumo CEMFLEX
 *   - Jose Luis Varilla+Arena $2,375 → Insumo 303-ARF-0201 (Varilla R-42 3/8)
 *                           + backfilled BankTransaction (Santander SPEI)
 *
 * Idempotent. Re-running is safe:
 *   - Doesn't duplicate BankTransactions (guards on bankTransactionId).
 *   - Re-sets the insumoId to the same value each time.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const BARTIZ_RFC = "CBA170606FQ8";

// Exact text of the descripcion used at seed time — matches the row uniquely.
const LINKS = [
  {
    beneficiario: "Lesly Flores",
    importeCents: 482500,
    insumoCodigo: "CEMFLEX",
    note: "PSP (imprimación-sellador pre-pintura) mapped to Sikatop Seal 107 insumo. Lesly actually sold PSP brand, not Sikatop; adjust if Bartiz has a dedicated PSP insumo.",
  },
  {
    beneficiario: "Luz Maria del Carmen",
    importeCents: 922800,
    insumoCodigo: "CEMFLEX",
    note: "Sellador (cementicio impermeable) maps to Sikatop Seal 107.",
  },
  {
    beneficiario: "Jose Luis Lopez Pozos",
    importeCents: 237500,
    insumoCodigo: "303-ARF-0201",
    note: "Varilla + arena — logged as varilla only (larger component). Arena share is small enough to ignore for v1.",
  },
];

async function main() {
  console.log("\n═══ Retro-link Bartiz paid gastos ═══\n");

  const company = await prisma.company.findUnique({
    where: { rfc: BARTIZ_RFC },
    select: { id: true, razonSocial: true },
  });
  if (!company) throw new Error("Bartiz company not found");
  console.log(`✓ Company: ${company.razonSocial}`);

  // 1. Look up each insumo by codigo
  const insumoByCodigo = new Map();
  for (const link of LINKS) {
    if (insumoByCodigo.has(link.insumoCodigo)) continue;
    const i = await prisma.insumo.findFirst({
      where: { companyId: company.id, codigo: link.insumoCodigo },
      select: { id: true, codigo: true, descripcion: true, costoActual: true, unidad: true },
    });
    if (!i) throw new Error(`Insumo ${link.insumoCodigo} not found — abort.`);
    insumoByCodigo.set(link.insumoCodigo, i);
    console.log(`  ✓ Insumo ${i.codigo.padEnd(16)} ${i.descripcion.slice(0, 50).padEnd(52)} ${i.unidad.padEnd(8)} $${i.costoActual.toFixed(2)}`);
  }

  // 2. Link each gasto
  for (const link of LINKS) {
    const importe = link.importeCents / 100;
    const gasto = await prisma.gasto.findFirst({
      where: {
        companyId: company.id,
        beneficiarioNombre: link.beneficiario,
        importe,
      },
      select: {
        id: true,
        estado: true,
        insumoId: true,
        bankTransactionId: true,
        bankAccountId: true,
        pagadoAt: true,
        descripcion: true,
      },
    });
    if (!gasto) {
      console.log(`  ⚠ No gasto found for ${link.beneficiario} $${importe}. Skip.`);
      continue;
    }
    const insumo = insumoByCodigo.get(link.insumoCodigo);
    await prisma.gasto.update({
      where: { id: gasto.id },
      data: {
        insumoId: insumo.id,
        indirecto: false,
        categoriaIndirecto: null,
      },
    });
    console.log(`  ✓ ${link.beneficiario.padEnd(24)} $${importe.toFixed(0).padStart(6)} → insumo ${insumo.codigo}`);

    // 3. Backfill BankTransaction if PAGADO but no BT (Jose Luis case)
    if (gasto.estado === "PAGADO" && !gasto.bankTransactionId) {
      const bt = await prisma.bankTransaction.create({
        data: {
          companyId: company.id,
          bankAccountId: gasto.bankAccountId,
          fecha: gasto.pagadoAt ?? new Date("2026-04-23T11:06:00"),
          descripcion: `[Backfill] Gasto ${link.beneficiario} — ${gasto.descripcion.slice(0, 60)}`,
          referencia: "SPEI Santander ref 3426520",
          monto: -importe,
          tipo: "DEBITO",
        },
      });
      await prisma.gasto.update({
        where: { id: gasto.id },
        data: { bankTransactionId: bt.id },
      });
      console.log(`     ↳ backfilled BankTransaction ${bt.id} (${bt.referencia})`);
    }
  }

  // 4. Final state dump
  console.log(`\n─── Estado final ────────────────────`);
  const gastos = await prisma.gasto.findMany({
    where: { companyId: company.id },
    select: {
      beneficiarioNombre: true,
      importe: true,
      estado: true,
      bankTransactionId: true,
      insumo: { select: { codigo: true, descripcion: true } },
      indirecto: true,
      categoriaIndirecto: true,
    },
    orderBy: { createdAt: "desc" },
  });
  for (const g of gastos) {
    const link = g.insumo
      ? `insumo ${g.insumo.codigo}`
      : g.indirecto
      ? `indirecto:${g.categoriaIndirecto}`
      : "❌ sin atribuir";
    const bt = g.bankTransactionId ? "🏦" : "—";
    console.log(`  ${g.estado.padEnd(11)} $${g.importe.toFixed(0).padStart(7)} ${g.beneficiarioNombre.slice(0, 22).padEnd(24)} ${link.padEnd(30)} ${bt}`);
  }
  console.log();
}

main()
  .catch((e) => {
    console.error("❌", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
