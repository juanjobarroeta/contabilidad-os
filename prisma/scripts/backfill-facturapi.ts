/* eslint-disable no-console */
// One-time script: provisions Facturapi orgs for every company that doesn't
// already have a facturapiOrgId. Run once after FACTURAPI_MASTER_KEY is set.
//
// Usage:
//   set -a && . .env.local && set +a
//   tsx prisma/scripts/backfill-facturapi.ts
// Or against production:
//   DATABASE_URL=postgres://... FACTURAPI_MASTER_KEY=sk_live_... \
//     tsx prisma/scripts/backfill-facturapi.ts

import { PrismaClient } from "@prisma/client";
import { provisionFacturapiOrg } from "../../src/lib/facturapi";

const prisma = new PrismaClient();

async function main() {
  const companies = await prisma.company.findMany({
    where: { isActive: true },
    select: {
      id: true,
      rfc: true,
      razonSocial: true,
      facturapiOrgId: true,
      facturapiApiKey: true,
      csdCer: true,
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`Found ${companies.length} companies\n`);

  let provisioned = 0;
  let skipped = 0;
  let failed = 0;

  for (const c of companies) {
    const tag = `[${c.rfc}] ${c.razonSocial}`;
    const hasOrg = !!c.facturapiOrgId;
    const hasKey = !!c.facturapiApiKey;
    const hasCsd = !!c.csdCer;

    if (hasOrg && hasKey) {
      console.log(`✓ SKIP  ${tag} — already has org + live key`);
      skipped++;
      continue;
    }

    process.stdout.write(`→ ${tag}${hasOrg ? " (org exists)" : ""}${hasCsd ? " (csd present)" : " (no csd)"}... `);

    const result = await provisionFacturapiOrg(c.id);

    if (result.ok) {
      const status = result.hasLiveKey ? "LIVE KEY" : result.csdUploaded ? "csd uploaded" : "org created";
      console.log(`✓ ${status}${result.warning ? ` — ${result.warning}` : ""}`);
      provisioned++;
    } else {
      console.log(`✗ ${result.error ?? "error desconocido"}`);
      failed++;
    }
  }

  console.log(`\nDone. Provisioned: ${provisioned}, Skipped: ${skipped}, Failed: ${failed}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
