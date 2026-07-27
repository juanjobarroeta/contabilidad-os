/**
 * Limpieza de datos de PRUEBA del satélite de construcción (bartiz) para
 * dejar la empresa lista para beta.
 *
 * BORRA (sólo lo que pidas por flags, dentro de UNA empresa):
 *   - Requisiciones (SolicitudCompra) + sus partidas/cotizaciones/
 *     adjudicaciones/aplicaciones (cascada) → esto vacía también las filas
 *     de Cuentas por pagar que salían de esas requisiciones.
 *   - Pagos a proveedor registrados (PagoProveedor) de prueba.
 *   - Gastos de prueba.
 *   - Proyectos de prueba completos (presupuestos, estimaciones, programa,
 *     bitácora, unidades, cuadrillas, rayas, reembolsos — por cascada; sus
 *     requisiciones/gastos/reembolsos se borran explícitamente antes).
 *   - Proveedores de prueba (sólo si ya no tienen refs duras; sus refs
 *     opcionales en movimientos bancarios/pagos/gastos se ponen en null).
 *   - Los VÍNCULOS de CFDI que apuntaban a lo borrado (la factura vuelve a
 *     "por vincular").
 *
 * NUNCA TOCA: CFDIs/facturas (Invoice), cuentas y movimientos bancarios,
 * estados de cuenta, declaraciones, ni nada del lado contable — sólo los
 * vínculos sueltos hacia registros borrados.
 *
 * DRY-RUN POR DEFECTO: imprime lo que borraría. Agrega --execute para
 * ejecutar de verdad (todo en una transacción).
 *
 * Uso:
 *   set -a; . ./.env.local; set +a     # o railway run …
 *   node scripts/cleanup-bartiz-test.mjs --company <RFC o id> [flags]
 *
 * Flags:
 *   --requisiciones all | FOLIO1,FOLIO2   requisiciones a borrar
 *   --pagos-proveedor all                 pagos a proveedor registrados
 *   --gastos all                          gastos capturados
 *   --proyectos CODIGO1,CODIGO2           proyectos completos (por código)
 *   --suppliers RFC1,RFC2                 proveedores de prueba (por RFC)
 *   --execute                             ejecutar (sin esto: dry-run)
 *
 * Ejemplo (limpieza típica pre-beta):
 *   node scripts/cleanup-bartiz-test.mjs --company BARTIZRFC \
 *     --requisiciones all --pagos-proveedor all --gastos all \
 *     --proyectos OO --suppliers BAHJ858578TU3,BAHN878787 --execute
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}

const args = parseArgs(process.argv);
const EXECUTE = args.execute === true;

if (!args.company) {
  console.error("Falta --company <RFC o id>. Ver el encabezado del script para el uso.");
  process.exit(1);
}

const list = (v) =>
  typeof v === "string" && v !== "all"
    ? v.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

async function main() {
  const company = await prisma.company.findFirst({
    where: { OR: [{ id: args.company }, { rfc: args.company }] },
    select: { id: true, rfc: true, razonSocial: true },
  });
  if (!company) {
    console.error(`Empresa no encontrada: ${args.company}`);
    process.exit(1);
  }
  const cid = company.id;
  console.log(`\nEmpresa: ${company.razonSocial} (${company.rfc})`);
  console.log(EXECUTE ? "⚠️  MODO EJECUCIÓN — se borrará de verdad\n" : "Dry-run (nada se borra; agrega --execute)\n");

  // ── Resolver qué borrar ──────────────────────────────────────────────────

  // Proyectos de prueba (por código)
  const proyCodes = list(args.proyectos);
  const proyectos = proyCodes.length
    ? await prisma.proyecto.findMany({
        where: { companyId: cid, codigo: { in: proyCodes } },
        select: { id: true, codigo: true, nombre: true },
      })
    : [];
  const proyIds = proyectos.map((p) => p.id);
  for (const c of proyCodes) {
    if (!proyectos.some((p) => p.codigo === c)) {
      console.warn(`  (aviso) proyecto con código "${c}" no encontrado — se ignora`);
    }
  }

  // Requisiciones: all | por folio | + las de los proyectos a borrar
  const reqWhere = { companyId: cid };
  let reqs = [];
  if (args.requisiciones === "all") {
    reqs = await prisma.solicitudCompra.findMany({
      where: reqWhere,
      select: { id: true, folio: true, estado: true },
    });
  } else {
    const folios = list(args.requisiciones);
    const or = [];
    if (folios.length) or.push({ folio: { in: folios } });
    if (proyIds.length) or.push({ proyectoId: { in: proyIds } });
    if (or.length) {
      reqs = await prisma.solicitudCompra.findMany({
        where: { ...reqWhere, OR: or },
        select: { id: true, folio: true, estado: true },
      });
    }
  }
  const reqIds = reqs.map((r) => r.id);

  // Pagos a proveedor
  const pagosProv =
    args["pagos-proveedor"] === "all"
      ? await prisma.pagoProveedor.findMany({
          where: { companyId: cid },
          select: { id: true, monto: true },
        })
      : [];
  const pagoProvIds = pagosProv.map((p) => p.id);

  // Gastos: all | + los de proyectos a borrar
  let gastos = [];
  if (args.gastos === "all") {
    gastos = await prisma.gasto.findMany({
      where: { companyId: cid },
      select: { id: true, descripcion: true, importe: true },
    });
  } else if (proyIds.length) {
    gastos = await prisma.gasto.findMany({
      where: { companyId: cid, proyectoId: { in: proyIds } },
      select: { id: true, descripcion: true, importe: true },
    });
  }
  const gastoIds = gastos.map((g) => g.id);

  // Proveedores de prueba (por RFC)
  const supRfcs = list(args.suppliers);
  const suppliers = supRfcs.length
    ? await prisma.supplier.findMany({
        where: { companyId: cid, rfc: { in: supRfcs } },
        select: { id: true, rfc: true, razonSocial: true },
      })
    : [];
  const supIds = suppliers.map((s) => s.id);
  for (const r of supRfcs) {
    if (!suppliers.some((s) => s.rfc === r)) {
      console.warn(`  (aviso) proveedor con RFC "${r}" no encontrado — se ignora`);
    }
  }

  // Vínculos de CFDI que apuntan a lo que se borra (la factura NO se toca;
  // vuelve a "por vincular").
  const vinculoTargets = [...reqIds, ...gastoIds];
  const vinculos = vinculoTargets.length
    ? await prisma.construccionCfdiVinculo.findMany({
        where: {
          companyId: cid,
          targetTipo: { in: ["SOLICITUD", "GASTO"] },
          targetId: { in: vinculoTargets },
        },
        select: { id: true },
      })
    : [];

  // ── Reporte ──────────────────────────────────────────────────────────────
  console.log(`Requisiciones a borrar: ${reqs.length}`);
  for (const r of reqs) console.log(`  · ${r.folio} (${r.estado})`);
  console.log(`Pagos a proveedor a borrar: ${pagosProv.length}`);
  console.log(`Gastos a borrar: ${gastos.length}`);
  console.log(`Proyectos a borrar: ${proyectos.length}`);
  for (const p of proyectos) console.log(`  · ${p.codigo} — ${p.nombre}`);
  console.log(`Proveedores a borrar: ${suppliers.length}`);
  for (const s of suppliers) console.log(`  · ${s.razonSocial} (${s.rfc})`);
  console.log(`Vínculos de CFDI a soltar: ${vinculos.length} (las facturas se conservan)`);
  console.log("\nSe conservan siempre: CFDIs/facturas, cuentas y movimientos bancarios, estados de cuenta y todo lo contable.\n");

  if (!EXECUTE) {
    console.log("Dry-run terminado. Repite con --execute para borrar.");
    return;
  }

  // ── Ejecución (orden respeta FKs; cascadas hacen el resto) ──────────────
  await prisma.$transaction(async (tx) => {
    // 1. Vínculos de CFDI hacia lo que se borra
    if (vinculos.length) {
      await tx.construccionCfdiVinculo.deleteMany({
        where: { id: { in: vinculos.map((v) => v.id) } },
      });
    }

    // 2. Pagos a proveedor (sus aplicaciones caen en cascada)
    if (pagoProvIds.length) {
      await tx.pagoProveedor.deleteMany({ where: { id: { in: pagoProvIds } } });
    }

    // 3. Requisiciones (partidas/cotizaciones/adjudicaciones/aplicaciones
    //    caen en cascada). Esto vacía las cuentas por pagar de prueba.
    if (reqIds.length) {
      await tx.solicitudCompra.deleteMany({ where: { id: { in: reqIds } } });
    }

    // 4. Gastos
    if (gastoIds.length) {
      await tx.gasto.deleteMany({ where: { id: { in: gastoIds } } });
    }

    // 5. Proyectos: primero sus hijos sin cascada (requisiciones/gastos ya
    //    cubiertos arriba si aplican; reembolsos y cualquier resto aquí),
    //    luego el proyecto (presupuestos/estimaciones/etc caen en cascada).
    if (proyIds.length) {
      await tx.solicitudCompra.deleteMany({ where: { proyectoId: { in: proyIds } } });
      await tx.gasto.deleteMany({ where: { proyectoId: { in: proyIds } } });
      await tx.reembolsoSemanal.deleteMany({ where: { proyectoId: { in: proyIds } } });
      await tx.proyecto.deleteMany({ where: { id: { in: proyIds } } });
    }

    // 6. Proveedores: soltar refs OPCIONALES (los movimientos bancarios y
    //    pagos se CONSERVAN, sólo pierden el vínculo al proveedor de prueba)
    //    y luego borrar. Si quedara una ref dura (p. ej. cotizaciones de una
    //    requisición que NO se borró), la transacción falla completa — nada
    //    queda a medias; quita ese RFC del flag o borra esa requisición.
    if (supIds.length) {
      await tx.bankTransaction.updateMany({
        where: { supplierId: { in: supIds } },
        data: { supplierId: null },
      });
      await tx.pagoProveedor.updateMany({
        where: { supplierId: { in: supIds } },
        data: { supplierId: null },
      });
      await tx.gasto.updateMany({
        where: { supplierId: { in: supIds } },
        data: { supplierId: null },
      });
      await tx.supplier.deleteMany({ where: { id: { in: supIds } } });
    }
  });

  console.log("✓ Limpieza ejecutada.");
}

main()
  .catch((e) => {
    console.error("Error — no se borró nada (transacción revertida):", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
