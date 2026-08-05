/**
 * One-shot: cambia el tope de empresas (maxEmpresas) de un despacho — p. ej.
 * ampliar una cortesía de "hasta 1 empresa" para dar de alta una segunda
 * empresa (con su FIEL) sin cobrar: el cobro es por el DUEÑO del despacho
 * (subscriptionStatus), no por empresa, así que en un despacho de cortesía
 * las empresas extra siguen sin cargo.
 *
 * Usage:
 *   set -a; . ./.env.local; set +a
 *   node scripts/set-despacho-max-empresas.mjs <nombre-del-despacho|despachoId> <max|null>
 *
 * Examples:
 *   node scripts/set-despacho-max-empresas.mjs "Jose Canales" 2
 *   node scripts/set-despacho-max-empresas.mjs "Jose Canales" null   # sin límite
 *
 * Idempotente. Imprime el estado (empresas activas, miembros, tope) antes y
 * después para verificar.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const ref = (process.argv[2] ?? "").trim();
  const maxRaw = (process.argv[3] ?? "").trim().toLowerCase();
  if (!ref || !maxRaw) {
    console.error(
      "Usage: node scripts/set-despacho-max-empresas.mjs <nombre-del-despacho|despachoId> <max|null>"
    );
    process.exit(1);
  }
  const max = maxRaw === "null" ? null : parseInt(maxRaw, 10);
  if (max !== null && (!Number.isInteger(max) || max < 1 || max > 100)) {
    console.error(`❌ max inválido: ${maxRaw} (usa un entero 1-100, o "null" para sin límite)`);
    process.exit(1);
  }

  // Por id exacto o por nombre (insensible a mayúsculas). Si el nombre empata
  // con varios despachos, se listan y no se toca nada.
  const candidatos = await prisma.despacho.findMany({
    where: { OR: [{ id: ref }, { name: { equals: ref, mode: "insensitive" } }] },
    include: {
      companies: { select: { id: true, razonSocial: true, rfc: true, isActive: true } },
      members: { select: { role: true, user: { select: { email: true } } } },
    },
  });
  if (candidatos.length === 0) {
    console.error(`❌ Ningún despacho con nombre o id "${ref}"`);
    process.exit(1);
  }
  if (candidatos.length > 1) {
    console.error(`❌ ${candidatos.length} despachos empatan con "${ref}" — usa el id:`);
    for (const d of candidatos) console.error(`   ${d.id} · ${d.name}`);
    process.exit(1);
  }
  const despacho = candidatos[0];
  const activas = despacho.companies.filter((c) => c.isActive);

  console.log(`\n✓ Despacho: ${despacho.name} (${despacho.id})`);
  console.log(`  tope actual: ${despacho.maxEmpresas ?? "sin límite"}`);
  console.log(`  empresas activas: ${activas.length}`);
  for (const c of activas) console.log(`    · ${c.razonSocial} (${c.rfc})`);
  console.log(
    `  miembros: ${despacho.members.map((m) => `${m.user.email} (${m.role})`).join(", ") || "(ninguno)"}`
  );

  await prisma.despacho.update({ where: { id: despacho.id }, data: { maxEmpresas: max } });

  console.log(`\n✅ maxEmpresas: ${despacho.maxEmpresas ?? "sin límite"} → ${max ?? "sin límite"}`);
  console.log(
    `\nNext: en ContabilidadOS, el despacho ya puede dar de alta ${
      max === null ? "empresas sin tope" : `hasta ${max} empresa${max === 1 ? "" : "s"}`
    } — alta normal de la empresa nueva (Ena Vima) y carga de su FIEL en Configuración → Fiscal. Sin cargo: el cobro va por el dueño del despacho (cortesía), no por empresa.`
  );
}

main()
  .catch((e) => {
    console.error("❌", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
