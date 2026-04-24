/**
 * One-shot: onboard Gerardo de Colombres Sánchez as owner of Decolsa.
 *
 * Idempotent on repeated runs. Does three things:
 *
 *   1. Ensures a Despacho exists for Decolsa ("Despacho Decolsa") and moves
 *      the Decolsa Company into it. This is critical — initially the Company
 *      was placed under Despacho Juan, which would auto-share it with every
 *      member of that despacho. Juan does NOT want Decolsa visible from his
 *      despacho; it's a separate customer.
 *
 *   2. Creates the User row for Gerardo if missing, with a bcrypt-hashed
 *      temporary password. Existing users are left alone (password not
 *      rehashed) so re-running doesn't lock him out.
 *
 *   3. Enrolls Gerardo as OWNER DespachoMember of Despacho Decolsa AND as
 *      OWNER CompanyMember on the Decolsa Company with full module access
 *      (allowedModules=[] = no restriction = both CONTABILIDAD +
 *      CONSTRUCCION).
 *
 * Because Gerardo is in Despacho Decolsa — which only owns the Decolsa
 * Company — he'll see only Decolsa in the company switcher. Juan's own
 * despacho (Despacho Juan) no longer owns Decolsa, so Juan, Enrique and
 * the contabilidad-os admin user will NOT see Decolsa.
 *
 * Usage:
 *   cd /Users/juanjosebarroeta/Documents/contabilidad-os
 *   set -a; . ./.env.local; set +a
 *   node scripts/create-decolsa-owner.mjs
 */

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const DECOLSA_RFC = "DIN1604261F8";
const DESPACHO_NAME = "Despacho Decolsa";
const OWNER = {
  email: "gdecolombres@decolsa.com",
  name: "Gerardo de Colombres Sánchez",
  // Temp password — Juan shares it with Gerardo out-of-band; Gerardo changes
  // it on first login. Write it out once so Juan can copy it from the log.
  tempPassword: "Decolsa2026!",
};

async function main() {
  console.log("\n═══ Onboard Decolsa owner ═══\n");

  // 1. Find the Decolsa Company
  const company = await prisma.company.findUnique({
    where: { rfc: DECOLSA_RFC },
    select: {
      id: true,
      razonSocial: true,
      despachoId: true,
      despacho: { select: { name: true } },
    },
  });
  if (!company) {
    console.error(`❌ Company ${DECOLSA_RFC} not found. Run create-decolsa-company.mjs first.`);
    process.exit(1);
  }
  console.log(`✓ Company: ${company.razonSocial}`);
  console.log(`  Currently in despacho: ${company.despacho?.name ?? "(none)"}`);

  // 2. Ensure Despacho Decolsa exists + move the Company into it
  let despacho = await prisma.despacho.findFirst({
    where: { name: DESPACHO_NAME },
    select: { id: true, name: true },
  });
  if (!despacho) {
    despacho = await prisma.despacho.create({
      data: { name: DESPACHO_NAME },
      select: { id: true, name: true },
    });
    console.log(`✓ Created Despacho: ${despacho.name} (${despacho.id})`);
  } else {
    console.log(`✓ Despacho exists: ${despacho.name} (${despacho.id})`);
  }

  if (company.despachoId !== despacho.id) {
    await prisma.company.update({
      where: { id: company.id },
      data: { despachoId: despacho.id },
    });
    console.log(`✓ Moved Company from "${company.despacho?.name}" → "${despacho.name}"`);
  } else {
    console.log(`✓ Company already in despacho "${despacho.name}"`);
  }

  // 3. Create or reuse the user row
  let user = await prisma.user.findUnique({
    where: { email: OWNER.email },
    select: { id: true, email: true, name: true, password: true },
  });
  let createdUser = false;
  let tempPasswordUsed = null;
  if (!user) {
    const hashed = await bcrypt.hash(OWNER.tempPassword, 10);
    user = await prisma.user.create({
      data: {
        email: OWNER.email,
        name: OWNER.name,
        password: hashed,
        subscriptionStatus: "ACTIVE", // Decolsa is a paying customer
      },
      select: { id: true, email: true, name: true, password: true },
    });
    createdUser = true;
    tempPasswordUsed = OWNER.tempPassword;
    console.log(`✓ Created User: ${user.email} (${user.id})`);
  } else {
    console.log(`✓ User already exists: ${user.email} (${user.id})`);
  }

  // 4. DespachoMember — guard the @@unique([userId]) constraint. If Gerardo
  //    was ever in a different despacho, bail loudly rather than silently
  //    moving him (unlikely for a brand-new user but cheap defensive check).
  const existingDespachoMembership = await prisma.despachoMember.findUnique({
    where: { userId: user.id },
    select: { id: true, despachoId: true, role: true, despacho: { select: { name: true } } },
  });
  if (existingDespachoMembership && existingDespachoMembership.despachoId !== despacho.id) {
    console.error(
      `❌ User ${user.email} is already in despacho "${existingDespachoMembership.despacho.name}". Remove them first.`
    );
    process.exit(1);
  }
  if (!existingDespachoMembership) {
    await prisma.despachoMember.create({
      data: { despachoId: despacho.id, userId: user.id, role: "OWNER" },
    });
    console.log(`✓ Added as OWNER of Despacho Decolsa`);
  } else {
    // Make sure role is OWNER
    if (existingDespachoMembership.role !== "OWNER") {
      await prisma.despachoMember.update({
        where: { id: existingDespachoMembership.id },
        data: { role: "OWNER" },
      });
    }
    console.log(`✓ Already OWNER of Despacho Decolsa`);
  }

  // 5. Explicit CompanyMember row — redundant with despacho membership for
  //    access, but provides the per-company role/allowedModules vector
  //    satellite apps and requireWriter/requireModule read.
  await prisma.companyMember.upsert({
    where: { userId_companyId: { userId: user.id, companyId: company.id } },
    create: {
      userId: user.id,
      companyId: company.id,
      role: "OWNER",
      allowedModules: [], // empty = no restriction = CONTABILIDAD + CONSTRUCCION
    },
    update: { role: "OWNER", allowedModules: [] },
  });
  console.log(`✓ CompanyMember OWNER on Decolsa (full module access)`);

  // 6. Sanity check: confirm Despacho Juan no longer owns Decolsa
  const juanDespacho = await prisma.despacho.findFirst({
    where: { name: "Despacho Juan" },
    include: { companies: { select: { rfc: true, razonSocial: true } } },
  });
  console.log(
    `\n✓ Despacho Juan now owns: ${juanDespacho?.companies.map((c) => c.rfc).join(", ") || "(none)"}`
  );
  const decolsaDespachoNow = await prisma.despacho.findUnique({
    where: { id: despacho.id },
    include: { companies: { select: { rfc: true, razonSocial: true } }, members: { select: { role: true, user: { select: { email: true } } } } },
  });
  console.log(
    `✓ Despacho Decolsa owns: ${decolsaDespachoNow?.companies.map((c) => c.rfc).join(", ")}`
  );
  console.log(
    `✓ Despacho Decolsa members: ${decolsaDespachoNow?.members
      .map((m) => `${m.user.email} (${m.role})`)
      .join(", ")}`
  );

  console.log("\n─── Summary ────────────────────────");
  console.log(`  Gerardo login URL:  https://<your-contabilidad-os-domain>/login`);
  console.log(`  Email:              ${OWNER.email}`);
  if (createdUser) {
    console.log(`  Temp password:      ${tempPasswordUsed}`);
    console.log(`  ⚠️  Share out-of-band. Tell Gerardo to change it on first login.`);
  } else {
    console.log(`  Password:           (unchanged — user already existed)`);
  }
  console.log();
  console.log("Access summary:");
  console.log("  - Gerardo: sees ONLY Decolsa (via Despacho Decolsa).");
  console.log("  - Gerardo has full access to both CONTABILIDAD + CONSTRUCCION modules.");
  console.log("  - Juan / admin / enrique: Despacho Juan members — they will NO LONGER");
  console.log("    see Decolsa in the company switcher.");
  console.log();
}

main()
  .catch((e) => {
    console.error("❌", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
