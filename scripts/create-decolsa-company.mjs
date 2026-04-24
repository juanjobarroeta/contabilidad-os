/**
 * One-shot: create Decolsa Ingeniería S.A. de C.V. as a Company under
 * Despacho Juan, enable CONTABILIDAD + CONSTRUCCION modules, and register
 * Gerardo de Colombres Sánchez (COSG910917D80) as a future card titular
 * reference (just a console note — BankAccount wiring lives in Phase 3).
 *
 * Idempotent: if the Company already exists (by RFC), the script updates
 * the fiscal data + re-enables modules and exits cleanly.
 *
 * Usage:
 *   cd /Users/juanjosebarroeta/Documents/contabilidad-os
 *   set -a; . ./.env.local; set +a
 *   node scripts/create-decolsa-company.mjs
 *
 * What it does NOT do (yet):
 *   - Create an OWNER user for Decolsa — waiting on an email address from
 *     Juan. Once given, run `create-decolsa-owner.mjs` or add the member
 *     via the UI.
 *   - Seed Torres Platino project / presupuesto — that needs the Phase 1
 *     frontend tree render; follow up with seed-decolsa-torres-platino.mjs.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Despacho Juan — the despacho that already owns Bartiz. Looked up at runtime
// by name so we don't hardcode IDs across environments.
const DESPACHO_NAME = "Despacho Juan";

// From the SAT Constancia de Situación Fiscal (9-abr-2026).
const DECOLSA = {
  rfc: "DIN1604261F8",
  razonSocial: "DECOLSA INGENIERIA S.A. DE C.V.",
  nombreComercial: "DECOLSA INGENIERIA",
  regimenFiscal: "601", // Régimen General de Ley Personas Morales
  codigoPostal: "72310",
  domicilioFiscal:
    "Boulevard del Casco 17-D, Bosques de San Sebastián, Puebla, Pue.",
  actividadEconomica: "Construcción de vivienda unifamiliar (40%)",
};

async function main() {
  console.log("\n═══ Create Decolsa Company ═══\n");

  const despacho = await prisma.despacho.findFirst({
    where: { name: DESPACHO_NAME },
    select: { id: true, name: true },
  });
  if (!despacho) {
    console.error(`❌ Despacho "${DESPACHO_NAME}" not found.`);
    process.exit(1);
  }
  console.log(`✓ Despacho: ${despacho.name} (${despacho.id})`);

  const existing = await prisma.company.findUnique({
    where: { rfc: DECOLSA.rfc },
    select: { id: true, razonSocial: true },
  });

  const company = existing
    ? await prisma.company.update({
        where: { id: existing.id },
        data: {
          despachoId: despacho.id,
          razonSocial: DECOLSA.razonSocial,
          nombreComercial: DECOLSA.nombreComercial,
          regimenFiscal: DECOLSA.regimenFiscal,
          codigoPostal: DECOLSA.codigoPostal,
          domicilioFiscal: DECOLSA.domicilioFiscal,
          actividadEconomica: DECOLSA.actividadEconomica,
          isActive: true,
        },
      })
    : await prisma.company.create({
        data: {
          despachoId: despacho.id,
          rfc: DECOLSA.rfc,
          razonSocial: DECOLSA.razonSocial,
          nombreComercial: DECOLSA.nombreComercial,
          regimenFiscal: DECOLSA.regimenFiscal,
          codigoPostal: DECOLSA.codigoPostal,
          domicilioFiscal: DECOLSA.domicilioFiscal,
          actividadEconomica: DECOLSA.actividadEconomica,
        },
      });

  console.log(
    `${existing ? "✓ Updated" : "✓ Created"} Company: ${company.razonSocial} (${company.rfc})`
  );
  console.log(`  id: ${company.id}`);

  // Enable both modules (same pattern as enable-construccion-module.mjs)
  for (const modulo of ["CONTABILIDAD", "CONSTRUCCION"]) {
    await prisma.companyModule.upsert({
      where: { companyId_modulo: { companyId: company.id, modulo } },
      create: { companyId: company.id, modulo },
      update: { habilitado: true },
    });
  }

  const modules = await prisma.companyModule.findMany({
    where: { companyId: company.id },
    orderBy: { modulo: "asc" },
  });
  console.log(
    `✓ Modules: ${modules.map((m) => `${m.modulo}${m.habilitado ? "" : " (disabled)"}`).join(", ")}`
  );

  console.log("\n─── Summary ────────────────────────");
  console.log(`  RFC:         ${company.rfc}`);
  console.log(`  Razón:       ${company.razonSocial}`);
  console.log(`  Régimen:     ${company.regimenFiscal} (General de Ley PM)`);
  console.log(`  CP:          ${company.codigoPostal}`);
  console.log(`  Despacho:    ${despacho.name}`);
  console.log(`  Construcción module: ENABLED`);
  console.log();
  console.log("Next steps:");
  console.log("  1. Add an OWNER CompanyMember for the Decolsa user (email?)");
  console.log("  2. Run scripts/seed-decolsa-torres-platino.mjs (after Phase 1 frontend ships)");
  console.log("  3. Phase 3: register Gerardo de Colombres Sánchez (COSG910917D80)");
  console.log("             as titular for the TD GDCS BankAccount");
  console.log();
}

main()
  .catch((e) => {
    console.error("❌", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
