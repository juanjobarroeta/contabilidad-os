/**
 * Admin: cambia el tier (CompanyPlan) de una o varias empresas por RFC.
 *
 * Usage:
 *   set -a; . ./.env.local; set +a
 *   node scripts/set-tier.mjs <TIER> <rfc> [rfc...]
 *   node scripts/set-tier.mjs <TIER> --despacho <despachoId>   # todas las del despacho
 *
 * Examples:
 *   node scripts/set-tier.mjs ASISTENTE ABC010101AAA XYZ020202BBB
 *   node scripts/set-tier.mjs ASISTENTE --despacho cmc123...
 *
 * Caso de uso principal: onboarding masivo SIN gastar Syntage todavía. Las
 * empresas nuevas nacen con tier AUTOMATIZADO (default del esquema), que
 * incluye Syntage — el cron de provisión les crearía entidad + credencial y
 * dispararía extracciones (que cuestan por pull). Con tier ASISTENTE el
 * gating (src/lib/planes.ts → planIncluyeSyntage) las salta por completo; el
 * sync de CFDIs (Descarga Masiva con e.firma propia), el timbrado y el chat
 * IA siguen funcionando. Cuando quieras activarles Syntage, vuelve a correr
 * el script con AUTOMATIZADO (o PRO) y el cron las aprovisiona solo.
 *
 * Idempotente. Imprime el antes/después de cada empresa.
 *
 * Why a script instead of a UI button:
 *   El tier lo fija normalmente el webhook de Stripe al comprar un plan. Este
 *   script es la herramienta de admin para casos manuales (onboarding
 *   negociado, white-label) mientras no exista panel de operador para tiers.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const TIERS = ["ASISTENTE", "AUTOMATIZADO", "PRO", "DESPACHO"];

async function main() {
  const [tierArg, ...rest] = process.argv.slice(2);
  const tier = (tierArg ?? "").toUpperCase().trim();
  if (!TIERS.includes(tier) || rest.length === 0) {
    console.error("Usage: node scripts/set-tier.mjs <TIER> <rfc> [rfc...]");
    console.error("       node scripts/set-tier.mjs <TIER> --despacho <despachoId>");
    console.error(`TIER: ${TIERS.join(" | ")}`);
    process.exit(1);
  }

  let companies;
  if (rest[0] === "--despacho") {
    const despachoId = rest[1];
    if (!despachoId) {
      console.error("❌ Falta el despachoId después de --despacho");
      process.exit(1);
    }
    companies = await prisma.company.findMany({
      where: { despachoId },
      select: { id: true, rfc: true, razonSocial: true, tier: true },
      orderBy: { rfc: "asc" },
    });
    if (companies.length === 0) {
      console.error(`❌ El despacho ${despachoId} no tiene empresas`);
      process.exit(1);
    }
  } else {
    const rfcs = rest.map((r) => r.toUpperCase().trim()).filter(Boolean);
    companies = await prisma.company.findMany({
      where: { rfc: { in: rfcs } },
      select: { id: true, rfc: true, razonSocial: true, tier: true },
      orderBy: { rfc: "asc" },
    });
    const found = new Set(companies.map((c) => c.rfc));
    const missing = rfcs.filter((r) => !found.has(r));
    if (missing.length > 0) {
      console.error(`❌ RFC(s) sin empresa: ${missing.join(", ")} — no se cambió nada.`);
      process.exit(1);
    }
  }

  console.log(`Cambiando ${companies.length} empresa(s) a tier ${tier}:\n`);
  for (const c of companies) {
    if (c.tier === tier) {
      console.log(`  = ${c.rfc}  ${c.razonSocial} — ya estaba en ${tier}`);
      continue;
    }
    await prisma.company.update({ where: { id: c.id }, data: { tier } });
    console.log(`  ✓ ${c.rfc}  ${c.razonSocial} — ${c.tier} → ${tier}`);
  }

  console.log(
    `\nListo. Syntage ${tier === "ASISTENTE" ? "QUEDA APAGADO" : "queda activo"} para estas empresas ` +
      `(gating por tier en src/lib/planes.ts; el cron de provisión lo respeta).`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
