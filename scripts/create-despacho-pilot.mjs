/**
 * Provisiona un PILOTO: crea un Despacho aislado + su usuario OWNER.
 * Reutilizable — corre uno por piloto. Idempotente (re-correr no rompe ni
 * recontraseña a un usuario existente).
 *
 * Cada despacho es un inquilino independiente: su OWNER sólo ve las empresas de
 * ESE despacho (todo filtra por despachoId). Distintos usuarios en distintos
 * despachos no se ven entre sí. El owner arranca SIN empresas y las agrega desde
 * la app (alta rápida + grupos).
 *
 * Hace tres cosas:
 *   1. Crea el Despacho (idempotente por nombre).
 *   2. Crea el User OWNER si no existe, con password temporal bcrypt
 *      (a uno existente NO se le recontraseña). subscriptionStatus = ACTIVE.
 *   3. Lo inscribe como OWNER DespachoMember (respeta @@unique(userId): si ya
 *      está en OTRO despacho, aborta en vez de moverlo en silencio).
 *
 * Uso:
 *   cd <repo>
 *   set -a; . ./.env.local; set +a            # carga DATABASE_URL
 *   node scripts/create-despacho-pilot.mjs "<Nombre Despacho>" <email> "<Nombre Owner>" [password]
 *
 * Ejemplo:
 *   node scripts/create-despacho-pilot.mjs "People HCS" enrique@peoplehcs.com.mx "Enrique"
 *
 * Si no pasas password, se genera una temporal aleatoria y se imprime al final.
 *
 * Supervisor (opcional) — para que el operador tenga un login dentro de ESTE
 * despacho como ACCOUNTANT (ve/opera todas las empresas del despacho, no
 * gestiona usuarios). Como un usuario sólo puede estar en UN despacho, el
 * supervisor debe ser una cuenta dedicada distinta a la del owner del piloto
 * y distinta a tu cuenta personal de operación. Para supervisión global
 * cross-despacho usa mejor scripts/set-operador.mjs (rol de plataforma).
 *
 *   SUPERVISOR_EMAIL=ops-people@tudominio.com \
 *   SUPERVISOR_NAME="Supervisor People" \
 *   node scripts/create-despacho-pilot.mjs "People HCS" enrique@peoplehcs.com.mx "Enrique"
 */

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

const prisma = new PrismaClient();

const [, , despachoNameArg, ownerEmailArg, ownerNameArg, passwordArg] = process.argv;

if (!despachoNameArg || !ownerEmailArg || !ownerNameArg) {
  console.error(
    'Uso: node scripts/create-despacho-pilot.mjs "<Nombre Despacho>" <email> "<Nombre Owner>" [password]'
  );
  process.exit(1);
}

const DESPACHO_NAME = despachoNameArg.trim();
const OWNER_EMAIL = ownerEmailArg.trim().toLowerCase();
const OWNER_NAME = ownerNameArg.trim();
// Password temporal: el que pasen, o una aleatoria legible.
const TEMP_PASSWORD =
  passwordArg?.trim() || `Pilot-${randomBytes(4).toString("hex")}!`;

if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(OWNER_EMAIL)) {
  console.error(`❌ Email inválido: ${OWNER_EMAIL}`);
  process.exit(1);
}

// Supervisor opcional (ACCOUNTANT de este despacho) vía env vars.
const SUPERVISOR_EMAIL = process.env.SUPERVISOR_EMAIL?.trim().toLowerCase() || null;
const SUPERVISOR_NAME = process.env.SUPERVISOR_NAME?.trim() || "Supervisor";
if (SUPERVISOR_EMAIL) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(SUPERVISOR_EMAIL)) {
    console.error(`❌ SUPERVISOR_EMAIL inválido: ${SUPERVISOR_EMAIL}`);
    process.exit(1);
  }
  if (SUPERVISOR_EMAIL === OWNER_EMAIL) {
    console.error(`❌ El supervisor no puede ser el mismo usuario que el owner.`);
    process.exit(1);
  }
}

async function main() {
  console.log(`\n═══ Provisionar piloto: ${DESPACHO_NAME} ═══\n`);

  // 1. Despacho (idempotente por nombre).
  let despacho = await prisma.despacho.findFirst({
    where: { name: DESPACHO_NAME },
    select: { id: true, name: true },
  });
  if (!despacho) {
    despacho = await prisma.despacho.create({
      data: { name: DESPACHO_NAME },
      select: { id: true, name: true },
    });
    console.log(`✓ Despacho creado: ${despacho.name} (${despacho.id})`);
  } else {
    console.log(`✓ Despacho ya existe: ${despacho.name} (${despacho.id})`);
  }

  // 2. User OWNER (idempotente por email; no recontraseña a uno existente).
  let user = await prisma.user.findUnique({
    where: { email: OWNER_EMAIL },
    select: { id: true, email: true },
  });
  let createdUser = false;
  if (!user) {
    const hashed = await bcrypt.hash(TEMP_PASSWORD, 10);
    user = await prisma.user.create({
      data: {
        email: OWNER_EMAIL,
        name: OWNER_NAME,
        password: hashed,
        subscriptionStatus: "ACTIVE", // pilotos = clientes activos
      },
      select: { id: true, email: true },
    });
    createdUser = true;
    console.log(`✓ Usuario creado: ${user.email} (${user.id})`);
  } else {
    console.log(`✓ Usuario ya existe: ${user.email} (${user.id}) — password sin cambios`);
  }

  // 3. DespachoMember OWNER — respeta @@unique(userId).
  const existing = await prisma.despachoMember.findUnique({
    where: { userId: user.id },
    select: { id: true, despachoId: true, role: true, despacho: { select: { name: true } } },
  });
  if (existing && existing.despachoId !== despacho.id) {
    console.error(
      `❌ ${user.email} ya pertenece al despacho "${existing.despacho.name}". ` +
        `Un usuario sólo puede estar en un despacho — usa otro usuario para este piloto.`
    );
    process.exit(1);
  }
  if (!existing) {
    await prisma.despachoMember.create({
      data: { despachoId: despacho.id, userId: user.id, role: "OWNER" },
    });
    console.log(`✓ Inscrito como OWNER de "${despacho.name}"`);
  } else {
    if (existing.role !== "OWNER") {
      await prisma.despachoMember.update({ where: { id: existing.id }, data: { role: "OWNER" } });
    }
    console.log(`✓ Ya es OWNER de "${despacho.name}"`);
  }

  // 4. Supervisor opcional — ACCOUNTANT de ESTE despacho.
  let supervisorPassword = null;
  let supervisorCreated = false;
  if (SUPERVISOR_EMAIL) {
    let sup = await prisma.user.findUnique({
      where: { email: SUPERVISOR_EMAIL },
      select: { id: true, email: true },
    });
    if (!sup) {
      supervisorPassword = `Sup-${randomBytes(4).toString("hex")}!`;
      const hashed = await bcrypt.hash(supervisorPassword, 10);
      sup = await prisma.user.create({
        data: {
          email: SUPERVISOR_EMAIL,
          name: SUPERVISOR_NAME,
          password: hashed,
          subscriptionStatus: "ACTIVE",
        },
        select: { id: true, email: true },
      });
      supervisorCreated = true;
      console.log(`✓ Supervisor creado: ${sup.email} (${sup.id})`);
    } else {
      console.log(`✓ Supervisor ya existe: ${sup.email} (${sup.id}) — password sin cambios`);
    }

    const supMember = await prisma.despachoMember.findUnique({
      where: { userId: sup.id },
      select: { id: true, despachoId: true, role: true, despacho: { select: { name: true } } },
    });
    if (supMember && supMember.despachoId !== despacho.id) {
      console.error(
        `❌ ${sup.email} ya pertenece al despacho "${supMember.despacho.name}". ` +
          `Un usuario sólo puede estar en un despacho — usa otra cuenta dedicada ` +
          `para supervisar, o usa scripts/set-operador.mjs para supervisión global.`
      );
      process.exit(1);
    }
    if (!supMember) {
      await prisma.despachoMember.create({
        data: { despachoId: despacho.id, userId: sup.id, role: "ACCOUNTANT" },
      });
      console.log(`✓ Supervisor inscrito como ACCOUNTANT de "${despacho.name}"`);
    } else {
      console.log(`✓ Supervisor ya es miembro de "${despacho.name}" (${supMember.role})`);
    }
  }

  // Verificación de aislamiento.
  const d = await prisma.despacho.findUnique({
    where: { id: despacho.id },
    include: {
      companies: { select: { rfc: true } },
      members: { select: { role: true, user: { select: { email: true } } } },
    },
  });
  console.log(`\n✓ "${d.name}" empresas: ${d.companies.map((c) => c.rfc).join(", ") || "(ninguna — se agregan desde la app)"}`);
  console.log(`✓ "${d.name}" miembros: ${d.members.map((m) => `${m.user.email} (${m.role})`).join(", ")}`);

  console.log("\n─── Resumen ────────────────────────");
  console.log(`  Login:    https://<tu-dominio>/login`);
  console.log(`  Email:    ${OWNER_EMAIL}`);
  if (createdUser) {
    console.log(`  Password: ${TEMP_PASSWORD}`);
    console.log(`  ⚠️  Compártela fuera de banda; pídele cambiarla al primer login.`);
  } else {
    console.log(`  Password: (sin cambios — el usuario ya existía)`);
  }
  console.log(`\n  ${OWNER_EMAIL} verá SÓLO las empresas de "${DESPACHO_NAME}" — aislado de otros despachos.`);

  if (SUPERVISOR_EMAIL) {
    console.log("\n─── Supervisor (ACCOUNTANT) ────────");
    console.log(`  Email:    ${SUPERVISOR_EMAIL}`);
    if (supervisorCreated) {
      console.log(`  Password: ${supervisorPassword}`);
      console.log(`  ⚠️  Compártela fuera de banda; pídele cambiarla al primer login.`);
    } else {
      console.log(`  Password: (sin cambios — el usuario ya existía)`);
    }
    console.log(`  Ve/opera todas las empresas de "${DESPACHO_NAME}" (no gestiona usuarios).`);
  }
  console.log();
}

main()
  .catch((e) => {
    console.error("❌", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
