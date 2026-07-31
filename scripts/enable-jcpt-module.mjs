/**
 * One-shot: enable the JCPT module on a Company.
 *
 * Usage:
 *   set -a; . ./.env.local; set +a
 *   node scripts/enable-jcpt-module.mjs <rfc>
 *
 * Example:
 *   node scripts/enable-jcpt-module.mjs CAXJ800101ABC
 *
 * Idempotent: upserts the CompanyModule row. Prints the Company + all its
 * current modules so you can verify the state before re-connecting the JCPT
 * platform (CoachOs).
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const rfc = (process.argv[2] ?? "").toUpperCase().trim();
  if (!rfc) {
    console.error("Usage: node scripts/enable-jcpt-module.mjs <rfc>");
    process.exit(1);
  }

  const company = await prisma.company.findUnique({
    where: { rfc },
    include: { modules: true, members: { select: { userId: true, role: true } } },
  });

  if (!company) {
    console.error(`❌ No company with RFC ${rfc}`);
    console.error(`   Create it first via the contabilidad-os web UI.`);
    process.exit(1);
  }

  console.log(`\n✓ Found company: ${company.razonSocial} (${rfc})`);
  console.log(`  id: ${company.id}`);
  console.log(`  members: ${company.members.length}`);
  console.log(
    `  current modules: ${
      company.modules.length
        ? company.modules.map((m) => `${m.modulo}${m.habilitado ? "" : " (disabled)"}`).join(", ")
        : "(none)"
    }`
  );

  // Ensure CONTABILIDAD is on (base product — every company should have it)
  await prisma.companyModule.upsert({
    where: { companyId_modulo: { companyId: company.id, modulo: "CONTABILIDAD" } },
    create: { companyId: company.id, modulo: "CONTABILIDAD" },
    update: { habilitado: true },
  });

  // Enable JCPT
  await prisma.companyModule.upsert({
    where: { companyId_modulo: { companyId: company.id, modulo: "JCPT" } },
    create: { companyId: company.id, modulo: "JCPT" },
    update: { habilitado: true },
  });

  const after = await prisma.companyModule.findMany({
    where: { companyId: company.id },
    orderBy: { modulo: "asc" },
  });

  console.log(
    `\n✅ Modules after update: ${after
      .map((m) => `${m.modulo}${m.habilitado ? "" : " (disabled)"}`)
      .join(", ")}\n`
  );
  console.log(
    `Next: JCPT's /cobros picks up the company on next load (it re-resolves from the hub — no re-login needed for the service user's cached token, but a fresh page load is enough).`
  );
}

main()
  .catch((e) => {
    console.error("❌", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
