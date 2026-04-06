/**
 * One-shot backfill: existing companies created before module-gating landed
 * have no CompanyModule rows. Give every existing company CONTABILIDAD (they
 * were already paying for it implicitly), and CONSTRUCCION on the test seed
 * company so the validation script has something to run against.
 *
 * Idempotent — safe to re-run.
 */
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const companies = await prisma.company.findMany({
  select: { id: true, rfc: true, razonSocial: true },
});

for (const c of companies) {
  // Always: CONTABILIDAD
  await prisma.companyModule.upsert({
    where: { companyId_modulo: { companyId: c.id, modulo: "CONTABILIDAD" } },
    create: { companyId: c.id, modulo: "CONTABILIDAD" },
    update: { habilitado: true },
  });
  console.log(`✓ ${c.razonSocial}: CONTABILIDAD enabled`);

  // Test seed company also gets CONSTRUCCION for validation
  if (c.rfc === "XAXX010101000") {
    await prisma.companyModule.upsert({
      where: { companyId_modulo: { companyId: c.id, modulo: "CONSTRUCCION" } },
      create: { companyId: c.id, modulo: "CONSTRUCCION" },
      update: { habilitado: true },
    });
    console.log(`✓ ${c.razonSocial}: CONSTRUCCION enabled (test company)`);
  }
}

await prisma.$disconnect();
