/**
 * One-shot: create (or link) the JCPT service user on a Company.
 *
 * The JCPT platform (CoachOs) authenticates server-to-server against
 * contabilidad-os with a dedicated service account that belongs ONLY to the
 * JCPT companies — so JCPT never sees other despacho clients, and personal
 * password changes can't break the sync.
 *
 * Idempotent:
 *   1. Finds the Company by RFC (works regardless of despacho — José's
 *      empresa was self-onboarded outside Despacho Juan).
 *   2. Creates the User if missing, with a bcrypt-hashed password (printed
 *      once so it can be copied into Railway). Existing users are left
 *      alone — password NOT rehashed.
 *   3. Upserts the CompanyMember (ACCOUNTANT) with allowedModules
 *      [CONTABILIDAD, JCPT] — enough for facturas/bancos reads, account
 *      creation, statement upload and the income ingest; nothing else.
 *
 * Usage:
 *   set -a; . ./.env.local; set +a
 *   node scripts/create-jcpt-service-user.mjs <rfc> <email> [password]
 *
 * Example:
 *   node scripts/create-jcpt-service-user.mjs CARE880406TX1 jcpt@josecanales.app
 *
 * Run it again with another RFC to link the same service user to a second
 * company (e.g. the SA de CV later).
 */

import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const rfc = (process.argv[2] ?? "").toUpperCase().trim();
  const email = (process.argv[3] ?? "").toLowerCase().trim();
  const passwordArg = process.argv[4];

  if (!rfc || !email) {
    console.error("Usage: node scripts/create-jcpt-service-user.mjs <rfc> <email> [password]");
    process.exit(1);
  }

  const company = await prisma.company.findUnique({
    where: { rfc },
    select: { id: true, razonSocial: true, despacho: { select: { name: true } } },
  });
  if (!company) {
    console.error(`❌ No company with RFC ${rfc}`);
    process.exit(1);
  }
  console.log(`\n✓ Company: ${company.razonSocial} (${rfc})`);
  console.log(`  despacho: ${company.despacho?.name ?? "(none — self-onboarded)"}`);

  let user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) {
    const password = passwordArg ?? randomBytes(12).toString("base64url");
    user = await prisma.user.create({
      data: {
        email,
        name: "JCPT (servicio)",
        password: await bcrypt.hash(password, 10),
      },
      select: { id: true },
    });
    console.log(`✓ Created service user ${email}`);
    console.log(`  password (copy into Railway CONTABILIDADOS_PASSWORD, shown ONCE): ${password}`);
  } else {
    console.log(`✓ User ${email} already exists — password unchanged`);
  }

  await prisma.companyMember.upsert({
    where: { userId_companyId: { userId: user.id, companyId: company.id } },
    create: {
      userId: user.id,
      companyId: company.id,
      role: "ACCOUNTANT",
      allowedModules: ["CONTABILIDAD", "JCPT"],
    },
    update: { role: "ACCOUNTANT", allowedModules: ["CONTABILIDAD", "JCPT"] },
  });
  console.log(`✓ CompanyMember: ACCOUNTANT on ${company.razonSocial} (modules: CONTABILIDAD, JCPT)`);

  const memberships = await prisma.companyMember.findMany({
    where: { userId: user.id },
    select: { company: { select: { rfc: true, razonSocial: true } }, role: true },
  });
  console.log(`\n✅ ${email} now belongs to:`);
  for (const m of memberships) {
    console.log(`   ${m.company.razonSocial} (${m.company.rfc}) — ${m.role}`);
  }
  console.log(
    `\nNext: set CONTABILIDADOS_EMAIL/PASSWORD on the CoachOs Railway service; /cobros resolves the company automatically.`
  );
}

main()
  .catch((e) => {
    console.error("❌", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
