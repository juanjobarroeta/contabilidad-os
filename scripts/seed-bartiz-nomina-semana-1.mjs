/**
 * Phase A-5: enable CONSTRUCCION_CUADRILLAS on Bartiz, build the
 * "Hacienda Ovinos" cuadrilla with the 7 workers from the GASTOS
 * SEMANA 1 PDF, and convert the single $31,700 NOMINA gasto into a
 * proper RayaSemanal with per-worker detail.
 *
 * Idempotent — re-runs upsert the cuadrilla, miembros, and raya by
 * stable keys (cuadrilla nombre + miembro nombre + raya semanaInicio).
 *
 * After this runs:
 *   - Bartiz can use the Destajo top-level page to see cuadrilla + raya
 *   - The single "Nómina semanal" indirecto gasto in Reembolso semana 1
 *     gets deleted; same money is now represented as a Raya with 7
 *     RayaDetalleMiembro rows that match the individual recibos.
 *
 * Usage:
 *   cd /Users/juanjosebarroeta/Documents/contabilidad-os
 *   set -a; . ./.env.local; set +a
 *   node scripts/seed-bartiz-nomina-semana-1.mjs
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const BARTIZ_RFC = "CBA170606FQ8";
const PROYECTO_CODIGO = "OBR-HACIENDA-OVINOS";
const SEMANA_INICIO = new Date("2026-04-13T00:00:00");
const SEMANA_FIN = new Date("2026-04-18T23:59:59");

// From GASTOS SEMANA 1 PDF page 16 ("NOMINA SEMANAL DEL 13 DE ABRIL...")
// salario + viáticos = total per recibo.
const MIEMBROS = [
  { nombre: "Serafín Luna Cote",        salario: 5800, viaticos:  750, rolEnCuadrilla: "Oficial" },
  { nombre: "Daniel Cote",              salario: 5800, viaticos: 1200, rolEnCuadrilla: "Oficial" },
  { nombre: "Jose Luis Alejo Nativitas", salario: 5800, viaticos: 1200, rolEnCuadrilla: "Oficial" },
  { nombre: "Bryan Martínez",           salario: 3800, viaticos: 1200, rolEnCuadrilla: "Ayudante" },
  { nombre: "Julieta Santiago",         salario: 2500, viaticos:    0, rolEnCuadrilla: "Ayudante" },
  { nombre: "Demetrio Enríquez Pozos",  salario: 5000, viaticos:    0, rolEnCuadrilla: "Ayudante" },
  { nombre: "Hernán Ochoa",             salario: 3000, viaticos:    0, rolEnCuadrilla: "Ayudante" },
];

async function main() {
  console.log("\n═══ Bartiz: enable CUADRILLAS + seed nómina semana 1 ═══\n");

  const company = await prisma.company.findUnique({
    where: { rfc: BARTIZ_RFC },
    select: { id: true, razonSocial: true },
  });
  if (!company) throw new Error("Bartiz not found");
  console.log(`✓ Company: ${company.razonSocial}`);

  // 1. Module flag
  await prisma.companyModule.upsert({
    where: { companyId_modulo: { companyId: company.id, modulo: "CONSTRUCCION_CUADRILLAS" } },
    create: { companyId: company.id, modulo: "CONSTRUCCION_CUADRILLAS" },
    update: { habilitado: true },
  });
  console.log(`✓ CONSTRUCCION_CUADRILLAS enabled`);

  // 2. Proyecto
  const proyecto = await prisma.proyecto.findFirst({
    where: { companyId: company.id, codigo: PROYECTO_CODIGO },
    select: { id: true },
  });
  if (!proyecto) throw new Error(`Proyecto ${PROYECTO_CODIGO} not found`);

  // 3. Cuadrilla "Hacienda Ovinos" (general — not per-trade since Bartiz has
  //    one mixed crew on this rehab).
  let cuadrilla = await prisma.cuadrilla.findFirst({
    where: { proyectoId: proyecto.id, nombre: "Hacienda Ovinos" },
  });
  if (!cuadrilla) {
    cuadrilla = await prisma.cuadrilla.create({
      data: {
        companyId: company.id,
        proyectoId: proyecto.id,
        nombre: "Hacienda Ovinos",
        especialidad: "GENERAL",
        jefeNombre: "Rosy Nativitas",
      },
    });
    console.log(`✓ Created cuadrilla: ${cuadrilla.nombre}`);
  } else {
    console.log(`✓ Cuadrilla already exists`);
  }

  // 4. Miembros — upsert by (cuadrillaId, nombre)
  const miembrosByNombre = new Map();
  for (const m of MIEMBROS) {
    let row = await prisma.cuadrillaMiembro.findFirst({
      where: { cuadrillaId: cuadrilla.id, nombre: m.nombre },
    });
    if (!row) {
      row = await prisma.cuadrillaMiembro.create({
        data: {
          cuadrillaId: cuadrilla.id,
          nombre: m.nombre,
          rolEnCuadrilla: m.rolEnCuadrilla,
        },
      });
      console.log(`  ✓ ${m.nombre} (${m.rolEnCuadrilla})`);
    }
    miembrosByNombre.set(m.nombre, row);
  }

  // 5. RayaSemanal — find existing by (cuadrillaId, semanaInicio) which
  //    is unique. If exists already, leave it alone (idempotent).
  let raya = await prisma.rayaSemanal.findUnique({
    where: { cuadrillaId_semanaInicio: { cuadrillaId: cuadrilla.id, semanaInicio: SEMANA_INICIO } },
  });
  const totalDestajo = MIEMBROS.reduce((a, m) => a + m.salario + m.viaticos, 0);
  if (!raya) {
    raya = await prisma.rayaSemanal.create({
      data: {
        companyId: company.id,
        proyectoId: proyecto.id,
        cuadrillaId: cuadrilla.id,
        semanaInicio: SEMANA_INICIO,
        semanaFin: SEMANA_FIN,
        totalDestajo,
        notas: "Semana 13-18 abril. Cubre nómina + viáticos del concentrado de gastos.",
        trabajos: {
          create: [{
            descripcion: "Trabajos generales semana 1 — rehab Hacienda Ovinos",
            importeDestajo: totalDestajo,
          }],
        },
        detalles: {
          create: MIEMBROS.map((m) => ({
            miembroId: miembrosByNombre.get(m.nombre).id,
            diasTrabajados: 6,
            importe: m.salario + m.viaticos,
          })),
        },
      },
      include: { detalles: { include: { miembro: true } } },
    });
    console.log(`✓ Created RayaSemanal $${totalDestajo} con ${MIEMBROS.length} miembros`);
  } else {
    console.log(`✓ Raya semanal already exists ($${raya.totalDestajo})`);
  }

  // 6. Delete the placeholder NOMINA gasto from the reembolso (avoid
  //    double-counting). Find by (proyectoId, beneficiarioNombre LIKE
  //    "Nómina semanal%", indirecto=true, categoriaIndirecto=NOMINA).
  const stale = await prisma.gasto.findMany({
    where: {
      proyectoId: proyecto.id,
      indirecto: true,
      categoriaIndirecto: "NOMINA",
      beneficiarioNombre: { contains: "Nómina semanal", mode: "insensitive" },
      estado: "PENDIENTE",
    },
    select: { id: true, importe: true, reembolsoId: true },
  });
  for (const g of stale) {
    // Need to recompute reembolso totals after delete
    await prisma.gasto.delete({ where: { id: g.id } });
    if (g.reembolsoId) {
      const agg = await prisma.gasto.aggregate({
        where: { reembolsoId: g.reembolsoId, estado: { not: "RECHAZADO" } },
        _sum: { importe: true },
      });
      const totalGastos = Math.round((agg._sum.importe ?? 0) * 100) / 100;
      const r = await prisma.reembolsoSemanal.findUnique({
        where: { id: g.reembolsoId },
        select: { anticipoAplicado: true },
      });
      await prisma.reembolsoSemanal.update({
        where: { id: g.reembolsoId },
        data: {
          totalGastos,
          totalReembolso: Math.round((totalGastos - (r?.anticipoAplicado ?? 0)) * 100) / 100,
        },
      });
    }
    console.log(`  🧹 Deleted placeholder NOMINA gasto $${g.importe}`);
  }

  console.log(`\n─── Resumen ──────────────────────────`);
  console.log(`  Cuadrilla:        ${cuadrilla.nombre} (general)`);
  console.log(`  Miembros:         ${MIEMBROS.length}`);
  console.log(`  Raya semana 1:    $${totalDestajo.toLocaleString("es-MX")} (BORRADOR)`);
  console.log(`  Reembolso semana: refrescado sin la línea NOMINA`);
  console.log();
  console.log(`Sigue: Katia abre Destajo en bartiz, revisa la raya, aprueba`);
  console.log(`       y paga (pago real fue parte del SPEI semanal a Rosy).`);
  console.log();
}

main()
  .catch((e) => { console.error("❌", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
