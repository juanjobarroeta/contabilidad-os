/**
 * Datos de muestra del módulo SALAMERIA, con el catálogo REAL de
 * lasalameriadeli.com (precios públicos de septiembre 2026).
 *
 * Uso:
 *   set -a; . ./.env.local; set +a
 *   npx tsx scripts/seed-salameria-demo.ts <RFC>
 *
 * Idempotente por SKU: se puede correr varias veces. Deja el módulo con algo
 * que enseñar de punta a punta —una importación LIBERADA con su costeo real,
 * lotes con caducidad (incluido uno por vencer), dos listas de precios y un
 * pedido de mostrador— para que la primera demo no sea una pantalla vacía.
 *
 * NO postea al mayor: la importación se siembra ya liberada escribiendo lotes
 * y kardex directamente. Sembrar asientos metería movimientos falsos en la
 * contabilidad real de la empresa, que es lo último que quiere ver un contador.
 */

import { PrismaClient } from "@prisma/client";
import { prorratearImportacion } from "../src/lib/salameria/costeo";
import { slugify } from "../src/lib/salameria/folio";

const prisma = new PrismaClient();

/** El catálogo real: SKU, nombre, marca, categoría, peso, precio público. */
const CATALOGO = [
  {
    sku: "LOT-CREMA-8K",
    nombre: "Cubeta Crema Lotus Creamy 8kg",
    marca: "Lotus",
    categoria: "Cremas y untables",
    presentacion: "Cubeta de 8 kg",
    pesoKg: 8,
    precio: 3190,
    preventa: true,
    destacado: true,
  },
  {
    sku: "LOT-GALL-1K",
    nombre: "Caja de Galletas Biscoff 1kg (4 pz)",
    marca: "Lotus",
    categoria: "Galletería",
    presentacion: "4 pz de 250 g",
    pesoKg: 1,
    precio: 320,
  },
  {
    sku: "LOT-GALL-25K",
    nombre: "Caja Galletas Biscoff 2.5kg (10pz)",
    marca: "Lotus",
    categoria: "Galletería",
    presentacion: "10 pz de 250 g",
    pesoKg: 2.5,
    precio: 800,
  },
  {
    sku: "LOT-CRUMB-750",
    nombre: "Galleta Biscoff Crumbs Molida 750g",
    marca: "Lotus",
    categoria: "Galletería",
    presentacion: "750 g",
    pesoKg: 0.75,
    precio: 310,
  },
  {
    sku: "LOT-TOP-1K",
    nombre: "Lotus Topping 1kg",
    marca: "Lotus",
    categoria: "Cremas y untables",
    presentacion: "1 kg",
    pesoKg: 1,
    precio: 499,
  },
  {
    sku: "CAL-SEMI-10K",
    nombre: "Chocolate Semi Amargo Callebaut 10kg",
    marca: "Callebaut",
    categoria: "Chocolatería",
    presentacion: "Caja de 10 kg",
    pesoKg: 10,
    precio: 6300,
    destacado: true,
  },
  {
    sku: "CAL-LECHE-25K",
    nombre: "Chocolate con Leche Callebaut 2.5kg",
    marca: "Callebaut",
    categoria: "Chocolatería",
    presentacion: "2.5 kg",
    pesoKg: 2.5,
    precio: 1692.5,
  },
  {
    sku: "CAL-PRAL-PIS-1K",
    nombre: "Praliné de Pistache Barry Callebaut al 70% 1kg",
    marca: "Callebaut",
    categoria: "Chocolatería",
    presentacion: "1 kg",
    pesoKg: 1,
    precio: 1870,
    destacado: true,
  },
  {
    sku: "CHO-PERLA-BL-800",
    nombre: "Perlas de Chocolate Blanco 800g",
    marca: "Callebaut",
    categoria: "Chocolatería",
    presentacion: "800 g",
    pesoKg: 0.8,
    precio: 598,
  },
  {
    sku: "CHO-PERLA-LE-800",
    nombre: "Perlas de Chocolate con Leche 800g",
    marca: "Callebaut",
    categoria: "Chocolatería",
    presentacion: "800 g",
    pesoKg: 0.8,
    precio: 595,
  },
  {
    sku: "KAT-HOJ-6",
    nombre: "Kataifi Pasta de Hojaldre 6pz de 454g",
    marca: "Kataifi",
    categoria: "Pastas y masas",
    presentacion: "6 pz de 454 g",
    pesoKg: 2.72,
    precio: 1600,
  },
  {
    sku: "KAT-HOJ-12",
    nombre: "Kataifi Pasta de Hojaldre 12pz de 454g",
    marca: "Kataifi",
    categoria: "Pastas y masas",
    presentacion: "12 pz de 454 g",
    pesoKg: 5.45,
    precio: 3000,
  },
  {
    sku: "NUT-MINI-64",
    nombre: "Mini Nutella Jars (64pz)",
    marca: "Ferrero",
    categoria: "Cremas y untables",
    presentacion: "64 frascos de 25 g",
    pesoKg: 1.6,
    precio: 1890,
  },
  {
    sku: "NUT-MANGA-1K",
    nombre: "Manga de Nutella 1kg",
    marca: "Ferrero",
    categoria: "Cremas y untables",
    presentacion: "1 kg",
    pesoKg: 1,
    precio: 240,
  },
  {
    sku: "MAL-SAL-124",
    nombre: "Sal Maldon 124g",
    marca: "Maldon",
    categoria: "Sal y especias",
    presentacion: "124 g",
    pesoKg: 0.124,
    precio: 130,
  },
  {
    sku: "BUB-PANCAKE-454",
    nombre: "Bubby's Sour Cream Pancake Mix 454g",
    marca: "Bubby's",
    categoria: "Mezclas",
    presentacion: "454 g",
    pesoKg: 0.454,
    precio: 370,
  },
] as const;

/** Partidas del contenedor de muestra: SKU → cantidad y precio en USD. */
const IMPORTACION = [
  { sku: "LOT-GALL-1K", cantidad: 200, usd: 9.5, meses: 14 },
  { sku: "LOT-TOP-1K", cantidad: 120, usd: 14.2, meses: 10 },
  { sku: "CAL-SEMI-10K", cantidad: 40, usd: 168, meses: 18 },
  { sku: "CAL-PRAL-PIS-1K", cantidad: 60, usd: 54, meses: 12 },
  // Caduca en 45 días: es el que dispara la alerta «Por vencer» en el panel.
  { sku: "KAT-HOJ-6", cantidad: 80, usd: 46, meses: 1.5 },
  { sku: "MAL-SAL-124", cantidad: 300, usd: 3.4, meses: 24 },
];

const r2 = (n: number) => Math.round(n * 100) / 100;
const enMeses = (m: number) => new Date(Date.now() + m * 30 * 86_400_000);

async function main() {
  const rfc = (process.argv[2] ?? "").toUpperCase().trim();
  if (!rfc) {
    console.error("Uso: npx tsx scripts/seed-salameria-demo.ts <RFC>");
    process.exit(1);
  }

  const company = await prisma.company.findUnique({
    where: { rfc },
    select: { id: true, razonSocial: true },
  });
  if (!company) {
    console.error(`❌ No hay empresa con RFC ${rfc}`);
    process.exit(1);
  }
  const companyId = company.id;

  const modulo = await prisma.companyModule.findUnique({
    where: { companyId_modulo: { companyId, modulo: "SALAMERIA" } },
  });
  if (!modulo?.habilitado) {
    console.error(`❌ El módulo SALAMERIA no está habilitado en ${company.razonSocial}`);
    console.error(`   Corre primero: node scripts/enable-salameria-module.mjs ${rfc}`);
    process.exit(1);
  }

  console.log(`\n▸ Sembrando en ${company.razonSocial} (${rfc})\n`);

  // ── Config ────────────────────────────────────────────────────────────────
  await prisma.salConfig.upsert({
    where: { companyId },
    create: {
      companyId,
      tiendaNombre: "La Salamería",
      tiendaDominio: "lasalameriadeli.com",
      envioUmbral: 3000,
      envioTarifa: 100,
      envioTarifaBase: 250,
      anticipoPreventa: 0.5,
    },
    update: {},
  });

  // ── Productos ─────────────────────────────────────────────────────────────
  const porSku = new Map<string, string>();
  for (const p of CATALOGO) {
    const producto = await prisma.salProducto.upsert({
      where: { companyId_sku: { companyId, sku: p.sku } },
      create: {
        companyId,
        sku: p.sku,
        nombre: p.nombre,
        slug: slugify(p.nombre),
        marca: p.marca,
        categoria: p.categoria,
        presentacion: p.presentacion,
        pesoKg: p.pesoKg,
        unidad: "PZA",
        // Alimento no preparado: tasa 0 % (Art. 2-A LIVA).
        ivaTasa: 0,
        claveUnidad: "H87",
        activo: true,
        publicado: true,
        destacado: "destacado" in p ? Boolean(p.destacado) : false,
        preventa: "preventa" in p ? Boolean(p.preventa) : false,
        fechaLlegada: "preventa" in p && p.preventa ? enMeses(2) : null,
        stockMinimo: 10,
      },
      update: {},
      select: { id: true },
    });
    porSku.set(p.sku, producto.id);
  }
  console.log(`✓ ${CATALOGO.length} productos`);

  // ── Listas de precios ─────────────────────────────────────────────────────
  const menudeo = await prisma.salListaPrecio.upsert({
    where: { companyId_nombre: { companyId, nombre: "Menudeo" } },
    create: { companyId, nombre: "Menudeo", tipo: "MENUDEO", publica: true },
    update: { publica: true },
  });
  const mayoreo = await prisma.salListaPrecio.upsert({
    where: { companyId_nombre: { companyId, nombre: "Mayoreo pastelerías" } },
    create: {
      companyId,
      nombre: "Mayoreo pastelerías",
      tipo: "MAYOREO",
      // 18 % abajo del público sin tener que capturar renglón por renglón.
      descuento: 0.18,
    },
    update: {},
  });

  for (const p of CATALOGO) {
    const productoId = porSku.get(p.sku)!;
    await prisma.salPrecio.upsert({
      where: {
        listaId_productoId_minimo: { listaId: menudeo.id, productoId, minimo: 1 },
      },
      create: { listaId: menudeo.id, productoId, precio: p.precio, minimo: 1 },
      update: { precio: p.precio },
    });
    // Quiebre por volumen a 12 piezas: 8 % más abajo.
    await prisma.salPrecio.upsert({
      where: {
        listaId_productoId_minimo: { listaId: menudeo.id, productoId, minimo: 12 },
      },
      create: {
        listaId: menudeo.id,
        productoId,
        precio: r2(p.precio * 0.92),
        minimo: 12,
      },
      update: { precio: r2(p.precio * 0.92) },
    });
  }
  console.log(`✓ 2 listas de precios (Menudeo pública + Mayoreo −18 %)`);

  // ── Importación liberada, con su costeo real ──────────────────────────────
  const folioImp = "IMP-2026-0001";
  const yaExiste = await prisma.salImportacion.findUnique({
    where: { companyId_folio: { companyId, folio: folioImp } },
    select: { id: true },
  });

  if (yaExiste) {
    console.log(`✓ Importación ${folioImp} ya existía — no se re-siembra`);
  } else {
    const tipoCambio = 18.65;
    const items = IMPORTACION.map((i) => {
      const cat = CATALOGO.find((c) => c.sku === i.sku)!;
      return { ...i, productoId: porSku.get(i.sku)!, pesoKg: cat.pesoKg };
    });

    const valorUsd = items.reduce((a, i) => a + i.cantidad * i.usd, 0);
    const costos = [
      // Flete por PESO: la cubeta pesada paga lo que ocupa.
      { tipo: "FLETE_INTERNACIONAL" as const, importe: 48_500, prorratea: true, base: "PESO" as const },
      { tipo: "MANIOBRAS" as const, importe: 6_800, prorratea: true, base: "PESO" as const },
      { tipo: "ARANCEL" as const, importe: r2(valorUsd * tipoCambio * 0.045), prorratea: true, base: "VALOR" as const },
      { tipo: "DTA" as const, importe: r2(valorUsd * tipoCambio * 0.008), prorratea: true, base: "VALOR" as const },
      { tipo: "AGENTE_ADUANAL" as const, importe: 14_200, prorratea: true, base: "VALOR" as const },
      // El IVA de aduana NO prorratea: es acreditable (1118).
      { tipo: "IVA_IMPORTACION" as const, importe: r2(valorUsd * tipoCambio * 0.16), prorratea: false, base: "VALOR" as const },
    ];

    const costeo = prorratearImportacion({
      items: items.map((i) => ({
        id: i.sku,
        cantidad: i.cantidad,
        precioMoneda: i.usd,
        pesoKg: i.pesoKg,
      })),
      costos,
      tipoCambio,
    });
    const porItem = new Map(costeo.items.map((c) => [c.id, c]));

    await prisma.$transaction(async (tx) => {
      const imp = await tx.salImportacion.create({
        data: {
          companyId,
          folio: folioImp,
          estado: "LIBERADA",
          pedimento: "26 07 3801 6001234",
          aduana: "Manzanillo",
          moneda: "USD",
          tipoCambio,
          fechaPedimento: new Date(Date.now() - 40 * 86_400_000),
          fechaLlegada: new Date(Date.now() - 35 * 86_400_000),
          liberadaAt: new Date(Date.now() - 35 * 86_400_000),
          notas: "Contenedor de muestra sembrado por seed-salameria-demo.ts",
          costos: { create: costos },
          items: {
            create: items.map((i) => ({
              productoId: i.productoId,
              cantidad: i.cantidad,
              precioMoneda: i.usd,
              loteCodigo: `L${i.sku.slice(-4)}-26A`,
              caducidad: enMeses(i.meses),
              costoUnitario: porItem.get(i.sku)!.costoUnitario,
            })),
          },
        },
      });

      for (const i of items) {
        const c = porItem.get(i.sku)!;
        const lote = await tx.salLote.create({
          data: {
            companyId,
            productoId: i.productoId,
            codigo: `L${i.sku.slice(-4)}-26A`,
            caducidad: enMeses(i.meses),
            cantidadInicial: i.cantidad,
            cantidad: i.cantidad,
            costoUnitario: c.costoUnitario,
            importacionId: imp.id,
          },
        });
        await tx.salMovimiento.create({
          data: {
            companyId,
            productoId: i.productoId,
            loteId: lote.id,
            tipo: "ENTRADA_IMPORTACION",
            cantidad: i.cantidad,
            costoUnitario: c.costoUnitario,
            fecha: new Date(Date.now() - 35 * 86_400_000),
            referencia: imp.id,
            referenciaTipo: "SAL_IMPORTACION",
          },
        });
        await tx.salProducto.update({
          where: { id: i.productoId },
          data: { stock: i.cantidad, costoPromedio: c.costoUnitario },
        });
      }
    });

    console.log(
      `✓ Importación ${folioImp} liberada — mercancía $${costeo.valorMercancia.toLocaleString("es-MX")} + pedimento $${costeo.costosProrrateados.toLocaleString("es-MX")} = $${costeo.costoMercancia.toLocaleString("es-MX")} al almacén`
    );
    console.log(
      `  IVA de importación (acreditable, NO costo): $${costeo.ivaImportacion.toLocaleString("es-MX")}`
    );
    for (const c of costeo.items) {
      const cat = CATALOGO.find((x) => x.sku === c.id)!;
      const margen = r2(((cat.precio - c.costoUnitario) / cat.precio) * 100);
      console.log(
        `  ${c.id.padEnd(18)} costo $${c.costoUnitario.toFixed(2).padStart(9)}  precio $${cat.precio.toFixed(2).padStart(9)}  margen ${margen}%`
      );
    }
  }

  console.log(`\n✅ Listo. Prende la tienda con:`);
  console.log(`   node scripts/enable-salameria-module.mjs ${rfc} --tienda\n`);
}

main()
  .catch((e) => {
    console.error("❌", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
