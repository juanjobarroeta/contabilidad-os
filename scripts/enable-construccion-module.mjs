/**
 * One-shot: enable the CONSTRUCCION module on a Company.
 *
 * Usage:
 *   set -a; . ./.env.local; set +a
 *   node scripts/enable-construccion-module.mjs <rfc>
 *
 * Example:
 *   node scripts/enable-construccion-module.mjs BRC250101ABC
 *
 * Idempotent: upserts the CompanyModule row. Prints the Company + all its
 * current modules so you can verify the state before re-logging into bartiz.
 *
 * Why a script instead of a UI button:
 *   Module gating will eventually be driven by a Stripe webhook (on add-on
 *   purchase). Until that ships, an admin enables modules by hand — this
 *   script is the admin tool.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const rfc = (process.argv[2] ?? "").toUpperCase().trim();
  if (!rfc) {
    console.error("Usage: node scripts/enable-construccion-module.mjs <rfc>");
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

  // Enable CONSTRUCCION
  await prisma.companyModule.upsert({
    where: { companyId_modulo: { companyId: company.id, modulo: "CONSTRUCCION" } },
    create: { companyId: company.id, modulo: "CONSTRUCCION" },
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
    `Next: log out + log back in on bartiz.vercel.app so AuthContext re-fetches the companies list.`
  );
}

main()
  .catch((e) => {
    console.error("❌", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
