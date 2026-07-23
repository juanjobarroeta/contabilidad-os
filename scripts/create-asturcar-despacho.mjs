/**
 * One-shot (idempotente): provisiona el despacho de prueba de Grupo Asturcar
 * para desarrollar el software automotriz sobre sus empresas.
 *
 * Hace, en orden y sin romper si ya existe:
 *   1. Despacho "Grupo Asturcar" (aislado — inquilino propio).
 *   2. User OWNER Manolo Martínez (mm@grupoasturcar.com) con password temporal
 *      bcrypt; a uno existente NO se le recontraseña. subscriptionStatus = ACTIVE.
 *   3. Company AUTOMOTRIZ GOMMAR (AGO150704NA9) dentro de ESE despacho, con los
 *      datos de su CSF (21-jul-2026). tier ASISTENTE: cero COGS de Syntage
 *      mientras es de prueba (sube a AUTOMATIZADO cuando entre en producción).
 *   4. Manolo como OWNER DespachoMember + OWNER CompanyMember (acceso total).
 *   5. Módulo CONTABILIDAD habilitado (base del hub).
 *
 * VISIBILIDAD DEL EQUIPO (Juanjo): NO se inscribe ninguna cuenta interna en el
 * despacho de Manolo. Manolo es dueño y ve SÓLO sus empresas; el equipo las ve
 * con el rol de OPERADOR de plataforma (User.esOperador=true, ya activo en
 * admin@contabilidad-os.com), que ve TODAS las empresas de TODOS los despachos
 * sin figurar como miembro. Si tu cuenta no fuera operador aún:
 *   node scripts/set-operador.mjs admin@contabilidad-os.com
 *
 * Uso:
 *   cd <repo>
 *   set -a; . ./.env.local; set +a            # carga DATABASE_URL
 *   node scripts/create-asturcar-despacho.mjs [password]
 *   # en Railway:  railway run node scripts/create-asturcar-despacho.mjs
 */

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

const prisma = new PrismaClient();

const DESPACHO_NAME = "Grupo Asturcar";
const OWNER = {
  email: "mm@grupoasturcar.com",
  name: "Manolo Martínez",
  // Temp password: el que pases como arg, o una aleatoria legible.
  tempPassword: process.argv[2]?.trim() || `Asturcar-${randomBytes(3).toString("hex")}!`,
};

// De la Constancia de Situación Fiscal (AGO150704NA9, 21-jul-2026).
// razonSocial = denominación EXACTA del padrón (sin sufijo societario) — así el
// nombre del emisor cuadra al timbrar (ver fix #432). El nombre comercial sí
// lleva "SA DE CV".
const COMPANY = {
  rfc: "AGO150704NA9",
  razonSocial: "AUTOMOTRIZ GOMMAR",
  nombreComercial: "AUTOMOTRIZ GOMMAR SA DE CV",
  regimenFiscal: "601", // Régimen General de Ley Personas Morales
  codigoPostal: "72190",
  domicilioFiscal:
    "Boulevard Atlixco 4717, Estrella del Sur, Puebla, Pue.",
  actividadEconomica: "Venta de automóviles nuevos al consumidor (90%)",
};

async function main() {
  console.log(`\n═══ Provisionar despacho de prueba: ${DESPACHO_NAME} ═══\n`);

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
    where: { email: OWNER.email },
    select: { id: true, email: true },
  });
  let createdUser = false;
  if (!user) {
    const hashed = await bcrypt.hash(OWNER.tempPassword, 10);
    user = await prisma.user.create({
      data: {
        email: OWNER.email,
        name: OWNER.name,
        password: hashed,
        subscriptionStatus: "ACTIVE",
      },
      select: { id: true, email: true },
    });
    createdUser = true;
    console.log(`✓ Usuario creado: ${user.email} (${user.id})`);
  } else {
    console.log(`✓ Usuario ya existe: ${user.email} (${user.id}) — password sin cambios`);
  }

  // 3. Company AUTOMOTRIZ GOMMAR bajo ESE despacho (idempotente por RFC).
  const existing = await prisma.company.findUnique({
    where: { rfc: COMPANY.rfc },
    select: { id: true, despachoId: true, despacho: { select: { name: true } } },
  });
  if (existing && existing.despachoId && existing.despachoId !== despacho.id) {
    console.error(
      `❌ La empresa ${COMPANY.rfc} ya pertenece al despacho "${existing.despacho?.name}". ` +
        `Muévela manualmente si en verdad va a Asturcar.`
    );
    process.exit(1);
  }
  const company = existing
    ? await prisma.company.update({
        where: { id: existing.id },
        data: { despachoId: despacho.id, tier: "ASISTENTE", isActive: true, ...COMPANY },
        select: { id: true, rfc: true, razonSocial: true },
      })
    : await prisma.company.create({
        data: { despachoId: despacho.id, tier: "ASISTENTE", ...COMPANY },
        select: { id: true, rfc: true, razonSocial: true },
      });
  console.log(`${existing ? "✓ Actualizada" : "✓ Creada"} empresa: ${company.razonSocial} (${company.rfc})`);

  // 4. DespachoMember OWNER — respeta @@unique(userId).
  const dm = await prisma.despachoMember.findUnique({
    where: { userId: user.id },
    select: { id: true, despachoId: true, despacho: { select: { name: true } } },
  });
  if (dm && dm.despachoId !== despacho.id) {
    console.error(`❌ ${user.email} ya pertenece al despacho "${dm.despacho.name}". Usa otro usuario.`);
    process.exit(1);
  }
  if (!dm) {
    await prisma.despachoMember.create({
      data: { despachoId: despacho.id, userId: user.id, role: "OWNER" },
    });
    console.log(`✓ Manolo inscrito como OWNER de "${despacho.name}"`);
  } else {
    console.log(`✓ Manolo ya es miembro de "${despacho.name}"`);
  }

  // 5. CompanyMember OWNER con acceso total (allowedModules=[] = sin restricción).
  await prisma.companyMember.upsert({
    where: { userId_companyId: { userId: user.id, companyId: company.id } },
    create: { userId: user.id, companyId: company.id, role: "OWNER", allowedModules: [] },
    update: { role: "OWNER", allowedModules: [] },
  });
  console.log(`✓ CompanyMember OWNER de ${company.razonSocial}`);

  // 6. Módulo base del hub.
  await prisma.companyModule.upsert({
    where: { companyId_modulo: { companyId: company.id, modulo: "CONTABILIDAD" } },
    create: { companyId: company.id, modulo: "CONTABILIDAD" },
    update: { habilitado: true },
  });
  console.log(`✓ Módulo CONTABILIDAD habilitado`);

  // 7. Confirmar quién lo verá vía operador (el equipo, sin ser miembro).
  const operadores = await prisma.user.findMany({
    where: { esOperador: true },
    select: { email: true },
  });

  console.log("\n─── Resumen ────────────────────────");
  console.log(`  Despacho:   ${despacho.name}`);
  console.log(`  Empresa:    ${company.razonSocial} (${company.rfc}) · tier ASISTENTE`);
  console.log(`  Login:      https://<tu-dominio>/login`);
  console.log(`  Dueño:      ${OWNER.email}`);
  if (createdUser) {
    console.log(`  Password:   ${OWNER.tempPassword}`);
    console.log(`  ⚠️  Compártela fuera de banda; pídele cambiarla al primer login.`);
  } else {
    console.log(`  Password:   (sin cambios — el usuario ya existía)`);
  }
  console.log(`\n  Verán este despacho por rol de OPERADOR (sin ser miembros):`);
  console.log(`    ${operadores.map((o) => o.email).join(", ") || "(⚠️ ninguno — corre set-operador.mjs sobre tu cuenta)"}`);
  console.log();
}

main()
  .catch((e) => {
    console.error("❌", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
