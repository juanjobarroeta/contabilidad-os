/**
 * Backfill PresupuestoPartida tree structure from the legacy zona+partida
 * flat strings.
 *
 * After the Capítulo tree schema change, existing Bartiz partidas have:
 *   - zona + partida strings (legacy)
 *   - parentPartidaId = null, nivel = 0, codigo = null, esRollup = false
 *
 * This script walks each Presupuesto, builds synthetic branch rows for
 * distinct (zona) and (zona, partida) combinations, then sets
 * parentPartidaId on the leaves to point at the deepest branch.
 *
 * Leaf IDs are preserved — EstimacionPartida and SolicitudPartida FKs
 * pointing at leaves remain valid.
 *
 * Idempotent: rows with parentPartidaId already set are skipped.
 *
 * Usage:
 *   set -a; . ./.env.local; set +a
 *   node scripts/backfill-partida-tree.mjs
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("\n═══ Backfill partida tree ═══\n");

  // Process each presupuesto independently
  const presupuestos = await prisma.presupuesto.findMany({
    select: { id: true, nombre: true, proyectoId: true, companyId: true },
  });

  let presProcessed = 0;
  let branchesCreated = 0;
  let leavesLinked = 0;
  let presSkipped = 0;

  for (const pres of presupuestos) {
    const partidas = await prisma.presupuestoPartida.findMany({
      where: { presupuestoId: pres.id },
      orderBy: { orden: "asc" },
    });

    if (partidas.length === 0) { presSkipped++; continue; }

    // Skip if any partida already has parentPartidaId (already migrated) or
    // if all partidas are esRollup (already a tree-native presupuesto)
    const alreadyTree = partidas.some(p => p.parentPartidaId !== null || p.esRollup);
    if (alreadyTree) { presSkipped++; continue; }

    // Only process partidas that have zona+partida set (legacy flat format)
    const withGrouping = partidas.filter(p => p.zona || p.partida);
    if (withGrouping.length === 0) { presSkipped++; continue; }

    // Build the tree: zona → partida → leaves
    // Track branches created: zonaBranches[zonaKey] = branch id
    //                        partidaBranches[zonaKey + '§' + partidaKey] = branch id
    const zonaBranches = new Map();
    const partidaBranches = new Map();

    // Group by zona (level 1) and (zona, partida) (level 2), preserving first-seen order
    const zonaOrder = [];
    const partidaOrderByZona = new Map();
    for (const p of partidas) {
      const z = p.zona ?? "Sin zona";
      const pa = p.partida ?? "Sin partida";
      if (!partidaOrderByZona.has(z)) {
        zonaOrder.push(z);
        partidaOrderByZona.set(z, []);
      }
      const partidaList = partidaOrderByZona.get(z);
      if (!partidaList.includes(pa)) partidaList.push(pa);
    }

    // Start orden high enough to sit above all leaves (offset for clarity).
    // But leaves keep their existing orden — branches just exist as metadata.
    let branchOrden = 10000;

    // Create zona branches (level 0, root)
    for (let zi = 0; zi < zonaOrder.length; zi++) {
      const z = zonaOrder[zi];
      const branch = await prisma.presupuestoPartida.create({
        data: {
          presupuestoId: pres.id,
          conceptoId: null,
          apuVersion: 1,
          cantidad: null,
          precioUnitario: 0,
          importe: 0,
          orden: branchOrden++,
          zona: z,
          nivel: 0,
          codigo: String(zi + 1),
          esRollup: true,
        },
      });
      zonaBranches.set(z, { id: branch.id, index: zi + 1 });
      branchesCreated++;

      // Create partida branches under this zona (level 1)
      const partidaList = partidaOrderByZona.get(z);
      for (let pi = 0; pi < partidaList.length; pi++) {
        const pa = partidaList[pi];
        const branchP = await prisma.presupuestoPartida.create({
          data: {
            presupuestoId: pres.id,
            conceptoId: null,
            apuVersion: 1,
            cantidad: null,
            precioUnitario: 0,
            importe: 0,
            orden: branchOrden++,
            zona: z,
            partida: pa,
            parentPartidaId: branch.id,
            nivel: 1,
            codigo: `${zi + 1}.${pi + 1}`,
            esRollup: true,
          },
        });
        partidaBranches.set(`${z}§${pa}`, { id: branchP.id, zonaIdx: zi + 1, partidaIdx: pi + 1 });
        branchesCreated++;
      }
    }

    // Now link each leaf to its (zona, partida) branch
    for (const p of partidas) {
      const z = p.zona ?? "Sin zona";
      const pa = p.partida ?? "Sin partida";
      const branch = partidaBranches.get(`${z}§${pa}`);
      if (!branch) continue;
      await prisma.presupuestoPartida.update({
        where: { id: p.id },
        data: {
          parentPartidaId: branch.id,
          nivel: 2,
          // Leaf codigo: branch.codigo + '.' + (leaf's position within partida)
          // We don't have a precomputed position, so use orden as a stand-in suffix
          codigo: `${branch.zonaIdx}.${branch.partidaIdx}.${p.orden}`,
          esRollup: false,
        },
      });
      leavesLinked++;
    }

    presProcessed++;
    console.log(`  ✓ ${pres.nombre ?? pres.id} — ${branchesCreated} branches, ${leavesLinked} leaves linked so far`);
  }

  console.log(`\n─── Summary ────────────────────────`);
  console.log(`  Presupuestos processed: ${presProcessed}`);
  console.log(`  Presupuestos skipped:   ${presSkipped} (no partidas, already migrated, or no zona/partida data)`);
  console.log(`  Branches created:       ${branchesCreated}`);
  console.log(`  Leaves linked:          ${leavesLinked}`);
  console.log();
}

main()
  .catch((e) => { console.error("❌", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
