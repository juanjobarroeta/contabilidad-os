/**
 * Invite a user restricted to specific modules on a specific company.
 *
 * Creates a User row (if missing) + CompanyMember row (if missing) with
 * per-user `allowedModules` populated. The user can then log into the
 * satellite app that serves those modules (e.g. bartiz for CONSTRUCCION)
 * but is redirected away from contabilidad-os's web UI by the layout
 * guard because they have no CONTABILIDAD in their allowed set.
 *
 * Usage:
 *   set -a; . ./.env.local; set +a
 *   node scripts/invite-restricted-user.mjs \
 *     --email constru.bartiz@gmail.com \
 *     --name "Rosy Valdez" \
 *     --rfc CBA170606FQ8 \
 *     --role ADMIN \
 *     --modules CONSTRUCCION \
 *     --password 'TempBartiz2026!'
 *
 * Flags:
 *   --email     (required)
 *   --name      (required)
 *   --rfc       (required) Company RFC to attach to
 *   --role      (optional) OWNER|ADMIN|ACCOUNTANT|VIEWER  — default ADMIN
 *   --modules   (required) Comma-separated list of ModuloApp values
 *               e.g. CONSTRUCCION   or   CONSTRUCCION,FLOTA
 *   --password  (optional) If omitted, a random 16-char password is
 *               generated and printed
 *
 * Idempotent: re-running updates the existing User's name + password
 * and upserts the CompanyMember row with the new role + allowedModules.
 */

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

const prisma = new PrismaClient();

// ── Arg parsing ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    args[a.slice(2)] = argv[i + 1];
    i++;
  }
}

const email = (args.email ?? "").toLowerCase().trim();
const name = (args.name ?? "").trim();
const rfc = (args.rfc ?? "").toUpperCase().trim();
const role = (args.role ?? "ADMIN").toUpperCase();
const modulesCsv = (args.modules ?? "").trim();
const password = args.password;

const VALID_ROLES = ["OWNER", "ADMIN", "ACCOUNTANT", "VIEWER"];
const VALID_MODULES = ["CONTABILIDAD", "CONSTRUCCION", "FLOTA", "MARKETING"];

if (!email || !name || !rfc || !modulesCsv) {
  console.error(
    "Usage: node scripts/invite-restricted-user.mjs --email X --name Y --rfc Z --modules CONSTRUCCION [--role ADMIN] [--password P]"
  );
  process.exit(1);
}

if (!VALID_ROLES.includes(role)) {
  console.error(`❌ --role must be one of ${VALID_ROLES.join(", ")}`);
  process.exit(1);
}

const allowedModules = modulesCsv
  .split(",")
  .map((m) => m.trim().toUpperCase())
  .filter(Boolean);

for (const m of allowedModules) {
  if (!VALID_MODULES.includes(m)) {
    console.error(
      `❌ Invalid module: ${m}. Valid: ${VALID_MODULES.join(", ")}`
    );
    process.exit(1);
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────
async function main() {
  log(`\n═══ Invite restricted user ═══\n`);

  // 1. Find or create the user
  let user = await prisma.user.findUnique({ where: { email } });
  const finalPassword = password ?? randomBytes(12).toString("base64url");
  const hashed = await bcrypt.hash(finalPassword, 10);

  if (user) {
    log(`✓ User already exists: ${email}`);
    user = await prisma.user.update({
      where: { email },
      data: {
        name,
        password: hashed, // always reset so the password printed below works
      },
    });
    log(`  password reset to the one below`);
  } else {
    user = await prisma.user.create({
      data: {
        email,
        name,
        password: hashed,
        subscriptionStatus: "ACTIVE", // restricted users don't get a trial clock
      },
    });
    log(`✓ User created: ${email}`);
  }

  // 2. Find the company
  const company = await prisma.company.findUnique({
    where: { rfc },
    select: {
      id: true,
      razonSocial: true,
      rfc: true,
      modules: {
        where: { habilitado: true },
        select: { modulo: true },
      },
    },
  });
  if (!company) {
    console.error(`❌ No company with RFC ${rfc}`);
    process.exit(1);
  }
  log(`✓ Target company: ${company.razonSocial} (${rfc})`);
  log(`  enabled modules: ${company.modules.map((m) => m.modulo).join(", ")}`);

  // Sanity check: every requested module must be enabled on the company
  const enabledSet = new Set(company.modules.map((m) => m.modulo));
  const unavailable = allowedModules.filter((m) => !enabledSet.has(m));
  if (unavailable.length > 0) {
    console.error(
      `❌ Requested modules [${unavailable.join(", ")}] are NOT enabled on ${rfc}.`
    );
    console.error(
      `   Run scripts/enable-construccion-module.mjs ${rfc} first (or enable other modules).`
    );
    process.exit(1);
  }

  // 3. Upsert the CompanyMember with the restriction
  const membership = await prisma.companyMember.upsert({
    where: { userId_companyId: { userId: user.id, companyId: company.id } },
    create: {
      userId: user.id,
      companyId: company.id,
      role,
      allowedModules,
    },
    update: {
      role,
      allowedModules,
    },
  });

  log(`\n✓ CompanyMember row upserted`);
  log(`  user:           ${user.email}`);
  log(`  company:        ${company.razonSocial} (${rfc})`);
  log(`  role:           ${membership.role}`);
  log(`  allowedModules: ${JSON.stringify(membership.allowedModules)}`);

  // 4. Print the access summary + password
  log(`\n─── Credenciales ────────────────────────────────────────`);
  log(`  Email:    ${email}`);
  log(`  Password: ${finalPassword}`);
  log(`─────────────────────────────────────────────────────────`);

  const hasContabilidad = allowedModules.includes("CONTABILIDAD");
  log(`\nAl iniciar sesión:`);
  if (hasContabilidad) {
    log(`  • contabilidad-os: ✓ acceso permitido`);
  } else {
    log(`  • contabilidad-os: ✗ redirigido a /acceso-restringido`);
  }
  const hasConstruccion = allowedModules.includes("CONSTRUCCION");
  log(
    `  • bartiz:          ${hasConstruccion ? "✓ acceso a " + rfc + " con módulo CONSTRUCCION" : "✗ sin empresas con CONSTRUCCION"}`
  );
  log(``);
  log(`Comparte las credenciales con el usuario. Pueden iniciar sesión en:`);
  log(
    `  ${hasContabilidad ? "https://contabilidad-os-production.up.railway.app  (acceso completo)" : ""}`
  );
  log(
    `  ${hasConstruccion ? "https://bartiz.vercel.app  (solo construcción)" : ""}`
  );
  log(``);
}

function log(...a) {
  console.log(...a);
}

main()
  .catch((e) => {
    console.error("❌", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
