/**
 * Check what a given user email can log into and see in bartiz.
 *
 * Usage:
 *   set -a; . ./.env.local; set +a
 *   node scripts/check-user-access.mjs renriquealvarez@gmail.com
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const email = (process.argv[2] ?? "").trim().toLowerCase();
if (!email) {
  console.error("Usage: node scripts/check-user-access.mjs <email>");
  process.exit(1);
}

const user = await prisma.user.findUnique({
  where: { email },
  select: {
    id: true,
    email: true,
    name: true,
    password: true,
    subscriptionStatus: true,
    trialEndsAt: true,
    createdAt: true,
    memberships: {
      include: {
        company: {
          select: {
            id: true,
            rfc: true,
            razonSocial: true,
            isActive: true,
            modules: {
              where: { habilitado: true },
              select: { modulo: true },
            },
          },
        },
      },
    },
  },
});

if (!user) {
  console.error(`❌ No user with email ${email}`);
  process.exit(1);
}

// Also check despacho membership (the despacho feature grants implicit access)
const despachoMember = await prisma.despachoMember.findFirst({
  where: { userId: user.id },
  include: {
    despacho: {
      select: {
        id: true,
        name: true,
        companies: {
          where: { isActive: true },
          select: {
            id: true,
            rfc: true,
            razonSocial: true,
            modules: {
              where: { habilitado: true },
              select: { modulo: true },
            },
          },
        },
      },
    },
  },
});

console.log(`\n─── User ${user.email} ────────────────────────────────`);
console.log(`  id:                 ${user.id}`);
console.log(`  name:               ${user.name ?? "(null)"}`);
console.log(`  created:            ${user.createdAt.toISOString()}`);
console.log(`  password set:       ${user.password ? "✓ yes" : "✗ NO (OAuth only, cannot login with password)"}`);
console.log(`  subscriptionStatus: ${user.subscriptionStatus}`);
console.log(`  trialEndsAt:        ${user.trialEndsAt?.toISOString() ?? "(null)"}`);

console.log("\n─── Direct company memberships ─────────────────────");
if (user.memberships.length === 0) {
  console.log("  (none)");
} else {
  for (const m of user.memberships) {
    const mods = m.company.modules.map((x) => x.modulo).join(", ") || "(none)";
    const hasConstruccion = m.company.modules.some((x) => x.modulo === "CONSTRUCCION");
    console.log(
      `  ${hasConstruccion ? "✓" : "·"} ${m.company.razonSocial} (${m.company.rfc}) — role: ${m.role}`
    );
    console.log(`    modules: ${mods}${hasConstruccion ? " 🏗️" : ""}`);
  }
}

console.log("\n─── Despacho membership (implicit company access) ──");
if (!despachoMember) {
  console.log("  (none)");
} else {
  console.log(`  Despacho: ${despachoMember.despacho.name} (role: ${despachoMember.role})`);
  console.log(`  Implicit access to ${despachoMember.despacho.companies.length} companies:`);
  for (const c of despachoMember.despacho.companies) {
    const mods = c.modules.map((x) => x.modulo).join(", ") || "(none)";
    const hasConstruccion = c.modules.some((x) => x.modulo === "CONSTRUCCION");
    console.log(`    ${hasConstruccion ? "✓" : "·"} ${c.razonSocial} (${c.rfc})`);
    console.log(`      modules: ${mods}${hasConstruccion ? " 🏗️" : ""}`);
  }
}

// Final verdict
console.log("\n─── Verdict ────────────────────────────────────────────");
const allCompanies = [
  ...user.memberships.map((m) => m.company),
  ...(despachoMember?.despacho.companies ?? []),
];
const uniqueById = new Map(allCompanies.map((c) => [c.id, c]));
const withConstruccion = [...uniqueById.values()].filter((c) =>
  c.modules.some((x) => x.modulo === "CONSTRUCCION")
);

if (!user.password) {
  console.log("❌ Cannot log into bartiz — user has no password set.");
  console.log("   This user was probably created via OAuth only. To fix:");
  console.log("   1. Have them sign out of bartiz");
  console.log("   2. Go to contabilidad-os and set a password via the profile page");
} else if (user.subscriptionStatus === "EXPIRED" || user.subscriptionStatus === "CANCELED") {
  console.log(`❌ Cannot log into bartiz — subscription is ${user.subscriptionStatus}`);
} else if (withConstruccion.length === 0) {
  console.log("⚠️  Login will succeed but Proyectos page will show");
  console.log('   "Módulo de Construcción no habilitado".');
  console.log("");
  console.log("   Fix: add this user as a CompanyMember of a company that");
  console.log("   has CONSTRUCCION enabled, OR enable CONSTRUCCION on a");
  console.log("   company the user already belongs to.");
} else {
  console.log(`✅ Can log into bartiz and will see ${withConstruccion.length} company(ies) with CONSTRUCCION:`);
  for (const c of withConstruccion) {
    console.log(`   • ${c.razonSocial} (${c.rfc})`);
  }
}

console.log();
await prisma.$disconnect();
