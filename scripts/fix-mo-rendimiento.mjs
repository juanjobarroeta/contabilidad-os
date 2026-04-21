/**
 * Fix MO insumo cantidades by applying cuadrilla rendimiento.
 *
 * The original import-matrices.mjs stored MO cantidades as they appear in
 * the Excel (per jornal crew composition: 1 albañil, 1 ayudante, 0.1 cabo).
 * These are NOT per-unit-of-concepto values — the rendimiento hadn't been
 * applied.
 *
 * The Excel structure has rendimiento per cuadrilla (each MO block ends with
 * a "Rendimiento: unit/JOR = X" row). To convert per-jornal to per-unit:
 *
 *   cantidad_per_unit = cantidad_per_jornal / rendimiento
 *
 * This script re-parses the Excel, extracts rendimiento per cuadrilla, and
 * updates each APUInsumo.cantidad and .importe for MANO_OBRA insumos only.
 * MATERIAL and EQUIPO insumos are untouched (their quantities are already
 * per-unit in the Excel).
 *
 * After running, the explosion de insumos returns correct totals.
 *
 * Usage:
 *   set -a; . ./.env.local; set +a
 *   node scripts/fix-mo-rendimiento.mjs
 */

import { PrismaClient } from "@prisma/client";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const prisma = new PrismaClient();
const COMPANY_RFC = "CBA170606FQ8";
const EXCEL_PATH = "/Users/juanjosebarroeta/Downloads/Matrices_Estándar_10-4-2026_Hr12Mn1.xlsx";
const round2 = (n) => Math.round(n * 100) / 100;

const pythonScript = `
import pandas as pd, json, sys

f = sys.argv[1]
df = pd.read_excel(f, sheet_name='Matrices', header=None)

# Parse each APU's MO structure: for each cuadrilla within an APU, capture
# which workers belong to it and what rendimiento applies.
#
# Cuadrilla boundary markers:
#   - Start of MO section: c0 == 'MANO DE OBRA'
#   - Cuadrilla header: c0 is a short code like '1P', '1H1A', '1CO1A' (not MO###)
#     with costoUnitario=0, marks the start of a new cuadrilla
#   - Individual worker: c0 starts with 'MO' + numeric
#   - Rendimiento row: c1 contains 'Rendimiento:' — applies to the cuadrilla
#     whose workers immediately precede it
#   - End of MO section: c0 == 'SUBTOTAL:' or next section marker

apus = {}
current_apu = None
in_mo_section = False
current_cuadrilla_workers = []
last_apu_cuadrillas = None

for i, row in df.iterrows():
    c0 = str(row[0]).strip() if pd.notna(row[0]) else ''
    c1 = str(row[1]).strip() if pd.notna(row[1]) else ''
    try: c3 = float(row[3]) if pd.notna(row[3]) else None
    except: c3 = None
    try: c5 = float(row[5]) if pd.notna(row[5]) else None
    except: c5 = None

    if c0 == 'Análisis:':
        current_apu = c1
        # Deduplicate: concepts can appear multiple times in the Excel
        # (once per partida that uses them). Only process the FIRST appearance.
        if current_apu in apus:
            current_apu = None  # skip subsequent occurrences
            continue
        apus[current_apu] = {'cuadrillas': []}
        last_apu_cuadrillas = apus[current_apu]['cuadrillas']
        in_mo_section = False
        current_cuadrilla_workers = []
        continue

    if not current_apu: continue

    if c0 == 'MANO DE OBRA':
        in_mo_section = True
        current_cuadrilla_workers = []
        continue
    if c0.startswith('SUBTOTAL:') or c0 in ('EQUIPO Y HERRAMIENTA', 'EQUIPO', 'MATERIALES'):
        in_mo_section = False
        current_cuadrilla_workers = []
        continue
    if not in_mo_section: continue

    # Rendimiento row — applies to the current cuadrilla
    # Some APUs use "Rendimiento:" (c5 = units/jor, divide by it)
    # Others use "Volumen:" (c5 = jor/unit directly, worker qty × c5 = per-unit)
    if 'Rendimiento:' in c1 and c5 is not None and c5 > 0 and current_cuadrilla_workers:
        last_apu_cuadrillas.append({
            'rendimiento': c5,  # units per jornal — divide worker qty by this
            'kind': 'rendimiento',
            'workers': [{'codigo': w['codigo'], 'cantidad': w['cantidad'], 'costoUnitario': w['costoUnitario']} for w in current_cuadrilla_workers],
        })
        current_cuadrilla_workers = []
        continue
    if 'Volumen:' in c1 and c5 is not None and c5 > 0 and current_cuadrilla_workers:
        # c5 is jornales per unit → worker qty × c5 = per-unit
        # This is equivalent to dividing by rendimiento = 1/c5
        last_apu_cuadrillas.append({
            'rendimiento': 1.0 / c5,  # convert volumen to rendimiento
            'kind': 'volumen',
            'workers': [{'codigo': w['codigo'], 'cantidad': w['cantidad'], 'costoUnitario': w['costoUnitario']} for w in current_cuadrilla_workers],
        })
        current_cuadrilla_workers = []
        continue

    # Worker row (MO### code) OR cuadrilla header row
    if c0.startswith('MO') and len(c0) >= 3 and c3 is not None and c5 is not None and c5 > 0:
        current_cuadrilla_workers.append({
            'codigo': c0,
            'cantidad': c5,
            'costoUnitario': c3,
        })
    # Cuadrilla header (e.g. '1P', '1H1A') resets the worker list
    elif c3 == 0 and c5 == 0 and c0 and not c0.startswith('MO'):
        # flush pending workers without rendimiento? probably means end of prior
        current_cuadrilla_workers = []

print(json.dumps(apus))
`;

async function main() {
  console.log("\n═══ Fix MO rendimiento ═══\n");

  const tmp = "/tmp/parse_rendimiento.py";
  writeFileSync(tmp, pythonScript);
  const raw = execSync(`/usr/bin/python3 ${tmp} "${EXCEL_PATH}"`, { maxBuffer: 10 * 1024 * 1024 }).toString();
  const apus = JSON.parse(raw);
  console.log(`✓ Parsed ${Object.keys(apus).length} APU rendimiento structures from Excel\n`);

  const company = await prisma.company.findUnique({ where: { rfc: COMPANY_RFC }, select: { id: true } });
  if (!company) { console.error("Company not found"); process.exit(1); }

  let fixedApus = 0, fixedLines = 0, skipped = 0;

  for (const [codigo, data] of Object.entries(apus)) {
    if (!data.cuadrillas || data.cuadrillas.length === 0) { skipped++; continue; }

    const concepto = await prisma.concepto.findFirst({
      where: {
        companyId: company.id,
        OR: [
          { codigo },
          // Handle IMP003 split
          { codigo: `${codigo}-AZOTEA` },
          { codigo: `${codigo}-MURO` },
        ],
      },
      include: { apuActual: { include: { insumos: { include: { insumo: true } } } } },
    });
    if (!concepto?.apuActual) continue;

    // Build map: worker codigo → { cantidad_correct, costoUnitario }
    // If multiple cuadrillas share the same worker (e.g. MO021 in two cuadrillas),
    // SUM the per-unit quantities
    const correctByWorker = new Map();
    for (const cuad of data.cuadrillas) {
      const rend = cuad.rendimiento > 0 ? cuad.rendimiento : 1;
      for (const w of cuad.workers) {
        const perUnitQty = w.cantidad / rend;
        if (!correctByWorker.has(w.codigo)) {
          correctByWorker.set(w.codigo, { cantidad: 0, costoUnitario: w.costoUnitario });
        }
        correctByWorker.get(w.codigo).cantidad += perUnitQty;
      }
    }

    // Update each MO APUInsumo line in this APU
    for (const line of concepto.apuActual.insumos) {
      if (!line.insumo || line.insumo.tipo !== "MANO_OBRA") continue;
      const correct = correctByWorker.get(line.insumo.codigo);
      if (!correct) continue;

      const newCantidad = round2(correct.cantidad);
      const newImporte = round2(newCantidad * line.costoUnitario);

      if (Math.abs(line.cantidad - newCantidad) > 0.001) {
        await prisma.aPUInsumo.update({
          where: { id: line.id },
          data: { cantidad: newCantidad, importe: newImporte },
        });
        fixedLines++;
      }
    }

    // Do NOT recompute costoDirecto or precioUnitario — those came from the
    // Excel and are already correct. We're only fixing the per-unit MO quantities
    // so the explosion aggregation works correctly.

    fixedApus++;
  }

  console.log(`✓ Fixed ${fixedApus} APUs (${fixedLines} MO lines updated), skipped ${skipped} with no rendimiento data\n`);

  // Verify: recompute the explosion sum for Básico and show MO total
  const pres = await prisma.presupuesto.findFirst({
    where: { proyecto: { companyId: company.id, codigo: "OBR-HACIENDA-OVINOS" }, estado: "APROBADO", tipoPresupuesto: "CONTRATO" },
    include: { partidas: { include: { concepto: { include: { apuActual: { include: { insumos: { include: { insumo: true } } } } } } } } },
  });
  if (!pres) return;

  let materialTotal = 0, moTotal = 0, equipoTotal = 0;
  for (const part of pres.partidas) {
    for (const line of part.concepto?.apuActual?.insumos ?? []) {
      if (!line.insumo) continue;
      const amount = part.cantidad * line.cantidad * line.costoUnitario;
      if (line.insumo.tipo === "MATERIAL") materialTotal += amount;
      else if (line.insumo.tipo === "MANO_OBRA") moTotal += amount;
      else equipoTotal += amount;
    }
  }

  console.log(`─── Nueva explosión (${pres.nombre}) ─────────────`);
  console.log(`  Materiales: $${materialTotal.toLocaleString("es-MX", { maximumFractionDigits: 0 })}`);
  console.log(`  Mano obra:  $${moTotal.toLocaleString("es-MX", { maximumFractionDigits: 0 })}`);
  console.log(`  Equipo:     $${equipoTotal.toLocaleString("es-MX", { maximumFractionDigits: 0 })}`);
  console.log(`  TOTAL:      $${(materialTotal + moTotal + equipoTotal).toLocaleString("es-MX", { maximumFractionDigits: 0 })}`);
  console.log(`  Presupuesto PU: $${pres.montoTotal.toLocaleString("es-MX", { maximumFractionDigits: 0 })}`);
}

main().catch((e) => { console.error("❌", e); process.exit(1); }).finally(() => prisma.$disconnect());
