/**
 * One-shot migration: create the EJECUTADO presupuesto for Hacienda Ovinos.
 *
 * Clones the APROBADO presupuesto into a new row with tipoPresupuesto=EJECUTADO,
 * creates a PresupuestoVersion v1, and migrates any existing anticipo data
 * into a Pago row.
 *
 * Usage:
 *   set -a; . ./.env.local; set +a
 *   node scripts/crear-ejecutado-hacienda.mjs
 *
 * Idempotent: skips if an EJECUTADO already exists for this proyecto.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const COMPANY_RFC = "CBA170606FQ8";
const PROYECTO_CODIGO = "OBR-HACIENDA-OVINOS";

async function main() {
  console.log("\n═══ Create Ejecutado for Hacienda Ovinos ═══\n");

  const company = await prisma.company.findUnique({
    where: { rfc: COMPANY_RFC },
    select: { id: true },
  });
  if (!company) { console.error("Company not found"); process.exit(1); }

  const proyecto = await prisma.proyecto.findUnique({
    where: { companyId_codigo: { companyId: company.id, codigo: PROYECTO_CODIGO } },
    select: { id: true, anticipoMonto: true, anticipoFecha: true, anticipoBankTxId: true },
  });
  if (!proyecto) { console.error("Proyecto not found"); process.exit(1); }

  // Find the APROBADO contrato
  const contrato = await prisma.presupuesto.findFirst({
    where: { proyectoId: proyecto.id, estado: "APROBADO" },
    include: {
      partidas: {
        select: {
          conceptoId: true, apuVersion: true, cantidad: true,
          precioUnitario: true, importe: true, orden: true, zona: true, partida: true,
        },
      },
    },
  });
  if (!contrato) {
    console.error("No APROBADO presupuesto found. Approve one first.");
    process.exit(1);
  }
  console.log(`✓ Contrato found: ${contrato.nombre} (v${contrato.version}), $${contrato.montoTotal}`);

  // Check if ejecutado already exists
  const existing = await prisma.presupuesto.findFirst({
    where: { proyectoId: proyecto.id, tipoPresupuesto: "EJECUTADO" },
  });
  if (existing) {
    console.log(`⚠️  Ejecutado already exists (${existing.nombre}). Skipping.`);
    return;
  }

  // Clone contrato → ejecutado
  const maxVersion = await prisma.presupuesto.aggregate({
    where: { proyectoId: proyecto.id },
    _max: { version: true },
  });
  const nextVersion = (maxVersion._max.version ?? 0) + 1;

  const ejecutado = await prisma.presupuesto.create({
    data: {
      companyId: company.id,
      proyectoId: proyecto.id,
      nombre: "Presupuesto Ejecutado",
      version: nextVersion,
      estado: "EN_EJECUCION",
      montoTotal: contrato.montoTotal,
      tipoPresupuesto: "EJECUTADO",
      contratoOrigenId: contrato.id,
      partidas: {
        create: contrato.partidas.map((p) => ({
          conceptoId: p.conceptoId,
          apuVersion: p.apuVersion,
          cantidad: p.cantidad,
          precioUnitario: p.precioUnitario,
          importe: p.importe,
          orden: p.orden,
          zona: p.zona,
          partida: p.partida,
        })),
      },
    },
  });
  console.log(`✓ Ejecutado created: v${ejecutado.version}, ${contrato.partidas.length} partidas`);

  // Create version 1 entry
  await prisma.presupuestoVersion.create({
    data: {
      presupuestoId: ejecutado.id,
      version: 1,
      descripcion: "Copia inicial del contrato aprobado",
      snapshotTotal: ejecutado.montoTotal,
    },
  });
  console.log("✓ PresupuestoVersion v1 created");

  // Migrate anticipo to Pago model if exists
  if (proyecto.anticipoMonto) {
    await prisma.pago.create({
      data: {
        proyectoId: proyecto.id,
        companyId: company.id,
        tipo: "ANTICIPO",
        monto: proyecto.anticipoMonto,
        fecha: proyecto.anticipoFecha ?? new Date(),
        referencia: "Migrado del campo Proyecto.anticipoMonto",
        bankTransactionId: proyecto.anticipoBankTxId,
      },
    });
    console.log(`✓ Anticipo migrated to Pago: $${proyecto.anticipoMonto}`);
  }

  console.log("\n✅ Done. The ejecutado is now editable in bartiz.\n");
}

main()
  .catch((e) => { console.error("❌", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
