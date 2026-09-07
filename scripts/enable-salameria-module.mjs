/**
 * One-shot: habilita el módulo SALAMERIA en una empresa y deja la tienda lista.
 *
 * Uso:
 *   set -a; . ./.env.local; set +a
 *   node scripts/enable-salameria-module.mjs <rfc> [--tienda]
 *
 * Ejemplo (La Salamería — Mercedes Trespalacios, persona física):
 *   node scripts/enable-salameria-module.mjs TEGM8503012K1 --tienda
 *
 * Idempotente: hace upsert del CompanyModule, de la SalConfig y de la lista de
 * precios pública. Se puede correr las veces que haga falta.
 *
 * `--tienda` además ENCIENDE la tienda pública (`tiendaActiva`). Va detrás de
 * una bandera a propósito: prender el escaparate es publicar precios en
 * internet, y no debe ser el efecto colateral de habilitar el ERP.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const rfc = (process.argv[2] ?? "").toUpperCase().trim();
  const prenderTienda = process.argv.includes("--tienda");

  if (!rfc) {
    console.error("Uso: node scripts/enable-salameria-module.mjs <rfc> [--tienda]");
    process.exit(1);
  }

  const company = await prisma.company.findUnique({
    where: { rfc },
    include: { modules: true, members: { select: { userId: true, role: true } } },
  });

  if (!company) {
    console.error(`❌ No hay empresa con RFC ${rfc}`);
    console.error(`   Créala primero en la UI de contabilidad-os.`);
    process.exit(1);
  }

  console.log(`\n✓ Empresa: ${company.razonSocial} (${rfc})`);
  console.log(`  id: ${company.id}`);
  console.log(`  miembros: ${company.members.length}`);
  console.log(
    `  módulos actuales: ${
      company.modules.length
        ? company.modules
            .map((m) => `${m.modulo}${m.habilitado ? "" : " (apagado)"}`)
            .join(", ")
        : "(ninguno)"
    }`
  );

  // CONTABILIDAD es el producto base: toda empresa lo trae.
  await prisma.companyModule.upsert({
    where: { companyId_modulo: { companyId: company.id, modulo: "CONTABILIDAD" } },
    create: { companyId: company.id, modulo: "CONTABILIDAD" },
    update: { habilitado: true },
  });

  await prisma.companyModule.upsert({
    where: { companyId_modulo: { companyId: company.id, modulo: "SALAMERIA" } },
    create: { companyId: company.id, modulo: "SALAMERIA" },
    update: { habilitado: true },
  });

  // La config con la regla de envío del letrero de lasalameriadeli.com:
  // «Envíos SÓLO $100 en compras de $3,000+».
  const config = await prisma.salConfig.upsert({
    where: { companyId: company.id },
    create: {
      companyId: company.id,
      tiendaNombre: "La Salamería",
      tiendaDominio: "lasalameriadeli.com",
      tiendaActiva: prenderTienda,
      envioUmbral: 3000,
      envioTarifa: 100,
      envioTarifaBase: 250,
      anticipoPreventa: 0.5,
      diasAlertaCaducidad: 90,
    },
    // Sólo la bandera de la tienda se pisa en el update: lo demás pudo
    // haberse ajustado a mano desde Configuración y no debe revertirse.
    update: prenderTienda ? { tiendaActiva: true } : {},
  });

  // Sin lista pública no hay precios, y sin precios el catálogo sale vacío.
  const publica = await prisma.salListaPrecio.findFirst({
    where: { companyId: company.id, publica: true },
    select: { id: true, nombre: true },
  });
  if (!publica) {
    const creada = await prisma.salListaPrecio.create({
      data: {
        companyId: company.id,
        nombre: "Menudeo",
        tipo: "MENUDEO",
        publica: true,
        activa: true,
      },
    });
    console.log(`\n✓ Lista pública creada: «${creada.nombre}»`);
  } else {
    console.log(`\n✓ Lista pública existente: «${publica.nombre}»`);
  }

  const after = await prisma.companyModule.findMany({
    where: { companyId: company.id },
    orderBy: { modulo: "asc" },
  });

  console.log(
    `\n✅ Módulos: ${after
      .map((m) => `${m.modulo}${m.habilitado ? "" : " (apagado)"}`)
      .join(", ")}`
  );
  console.log(`   Tienda pública: ${config.tiendaActiva ? "ENCENDIDA" : "apagada"}`);
  console.log(`\nFalta:`);
  console.log(`  1. API_ALLOWED_ORIGINS += el origen del ADMIN y el de la TIENDA.`);
  console.log(`  2. Cerrar y volver a abrir sesión en el satélite (AuthContext re-lee empresas).`);
  if (!prenderTienda) {
    console.log(`  3. Prender la tienda con --tienda cuando el catálogo ya tenga precios.`);
  }
  console.log("");
}

main()
  .catch((e) => {
    console.error("❌", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
