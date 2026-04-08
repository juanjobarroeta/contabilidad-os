/**
 * Check what a given user email can log into and see in bartiz.
 *
 * Accounts for the CompanyMember.allowedModules restriction: if a user's
 * allowedModules is non-empty, the effective module set is the intersection
 * of company enabled modules and the allowed set. Empty = full access.
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

function effectiveModules(companyEnabled, allowed) {
  if (!allowed || allowed.length === 0) return companyEnabled;
  const set = new Set(allowed);
  return companyEnabled.filter((m) => set.has(m));
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

// allowedModules lives on CompanyMember itself
const membershipRows = await prisma.companyMember.findMany({
  where: { userId: user.id },
  select: { companyId: true, allowedModules: true },
});
const allowedByCompanyId = new Map(
  membershipRows.map((m) => [m.companyId, m.allowedModules ?? []])
);

// Despacho membership (grants implicit full access to all company modules)
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
console.log(
  `  password set:       ${user.password ? "✓ yes" : "✗ NO (OAuth only, cannot login with password)"}`
);
console.log(`  subscriptionStatus: ${user.subscriptionStatus}`);
console.log(`  trialEndsAt:        ${user.trialEndsAt?.toISOString() ?? "(null)"}`);

console.log("\n─── Direct company memberships ─────────────────────");
if (user.memberships.length === 0) {
  console.log("  (none)");
} else {
  for (const m of user.memberships) {
    const allowed = allowedByCompanyId.get(m.company.id) ?? [];
    const enabled = m.company.modules.map((x) => x.modulo);
    const effective = effectiveModules(enabled, allowed);
    const restricted = allowed.length > 0;
    const hasConstruccion = effective.includes("CONSTRUCCION");
    console.log(
      `  ${hasConstruccion ? "✓" : "·"} ${m.company.razonSocial} (${m.company.rfc}) — role: ${m.role}`
    );
    console.log(`    company enabled: ${enabled.join(", ") || "(none)"}`);
    if (restricted) {
      console.log(`    allowedModules:  ${allowed.join(", ")} (RESTRICTED)`);
      console.log(`    effective:       ${effective.join(", ") || "(none)"}${hasConstruccion ? " 🏗️" : ""}`);
    } else {
      console.log(`    effective:       ${effective.join(", ") || "(none)"} (full access)${hasConstruccion ? " 🏗️" : ""}`);
    }
  }
}

console.log("\n─── Despacho membership (implicit full access) ─────");
if (!despachoMember) {
  console.log("  (none)");
} else {
  console.log(`  Despacho: ${despachoMember.despacho.name} (role: ${despachoMember.role})`);
  console.log(
    `  Implicit access to ${despachoMember.despacho.companies.length} companies:`
  );
  for (const c of despachoMember.despacho.companies) {
    const mods = c.modules.map((x) => x.modulo).join(", ") || "(none)";
    const hasConstruccion = c.modules.some((x) => x.modulo === "CONSTRUCCION");
    console.log(`    ${hasConstruccion ? "✓" : "·"} ${c.razonSocial} (${c.rfc})`);
    console.log(`      full modules: ${mods}${hasConstruccion ? " 🏗️" : ""}`);
  }
}

// Verdict — consider both direct + despacho paths
console.log("\n─── Verdict ────────────────────────────────────────────");

const directEffectiveByCompany = new Map();
for (const m of user.memberships) {
  const allowed = allowedByCompanyId.get(m.company.id) ?? [];
  const enabled = m.company.modules.map((x) => x.modulo);
  directEffectiveByCompany.set(m.company.id, {
    rfc: m.company.rfc,
    razonSocial: m.company.razonSocial,
    effective: effectiveModules(enabled, allowed),
    isActive: m.company.isActive,
  });
}

// Despacho companies contribute full enabled modules
if (despachoMember) {
  for (const c of despachoMember.despacho.companies) {
    if (directEffectiveByCompany.has(c.id)) continue;
    directEffectiveByCompany.set(c.id, {
      rfc: c.rfc,
      razonSocial: c.razonSocial,
      effective: c.modules.map((x) => x.modulo),
      isActive: true,
    });
  }
}

// Is user allowed into contabilidad-os web UI?
const canAccessContabilidad = [...directEffectiveByCompany.values()].some(
  (c) => c.isActive && c.effective.includes("CONTABILIDAD")
);
// Bartiz view: companies with CONSTRUCCION in effective set
const bartizCompanies = [...directEffectiveByCompany.values()].filter(
  (c) => c.isActive && c.effective.includes("CONSTRUCCION")
);

if (!user.password) {
  console.log("❌ Cannot log in — user has no password set.");
} else if (user.subscriptionStatus === "EXPIRED" || user.subscriptionStatus === "CANCELED") {
  console.log(`❌ Cannot log in — subscription is ${user.subscriptionStatus}`);
} else {
  console.log(
    `  contabilidad-os web UI: ${canAccessContabilidad ? "✅ allowed" : "🚫 redirected to /acceso-restringido"}`
  );
  if (bartizCompanies.length === 0) {
    console.log("  bartiz:                 🚫 no companies with CONSTRUCCION");
  } else {
    console.log(
      `  bartiz:                 ✅ access to ${bartizCompanies.length} company(ies) with CONSTRUCCION:`
    );
    for (const c of bartizCompanies) {
      console.log(`                          • ${c.razonSocial} (${c.rfc})`);
    }
  }
}

console.log();
await prisma.$disconnect();
