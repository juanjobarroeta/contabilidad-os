/**
 * Import the 298 insumos from the Torres Platino Excel INSUMOS sheet
 * into Decolsa's catálogo maestro.
 *
 * Source file:
 *   /Users/juanjosebarroeta/Downloads/1.- PRESUPUESTO - PROTOTIPO 3R  - TORRES PLATINO 300623.xls
 *   Sheet "INSUMOS" — 327 rows with category headers + insumo rows.
 *
 * Category → InsumoTipo mapping:
 *   Material       → MATERIAL      (237 rows)
 *   Mano de Obra   → MANO_OBRA     ( 20 rows)
 *   Herramienta    → HERRAMIENTA   (  3 rows)
 *   Equipo         → EQUIPO        (  7 rows)
 *   Contrato       → BASICO        ( 30 rows)  — subcontratos de mano de obra
 *   Flete          → BASICO        (  1 row )  — no dedicated enum value
 *
 * The "Contrato" category in this Excel is destajo contractor flat fees
 * (Albañileria, Plomería, Electrico…). Mapping to BASICO until we add a
 * dedicated SUBCONTRATO tipo — works because BASICO is also a "composed
 * cost with no material breakdown."
 *
 * Costo: the "Costo" column is unit cost at the time the budget was
 * prepared (Jun 2023). That becomes costoActual; we don't have a
 * history log. If Decolsa repricing happens later they can run
 * /insumos/actualizar-precios.
 *
 * Idempotent: upserts by (companyId, codigo). Re-running updates the
 * costoActual + descripcion but never deletes insumos, so live APUInsumo
 * references stay valid.
 *
 * Usage:
 *   cd /Users/juanjosebarroeta/Documents/contabilidad-os
 *   set -a; . ./.env.local; set +a
 *   node scripts/import-insumos-decolsa.mjs
 */

import { PrismaClient } from "@prisma/client";
import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const prisma = new PrismaClient();

const DECOLSA_RFC = "DIN1604261F8";
const EXCEL_PATH =
  "/Users/juanjosebarroeta/Downloads/1.- PRESUPUESTO - PROTOTIPO 3R  - TORRES PLATINO 300623.xls";

const CATEGORY_TO_TIPO = {
  Material: "MATERIAL",
  "Mano de Obra": "MANO_OBRA",
  Herramienta: "HERRAMIENTA",
  Equipo: "EQUIPO",
  Contrato: "BASICO",
  Flete: "BASICO",
};

function parseExcel() {
  const py = `
import pandas as pd, json, sys

f = sys.argv[1]
df = pd.read_excel(f, sheet_name='INSUMOS', header=None)

rows = []
current_cat = None
# Data starts at row 4 (0-indexed). Row 2 = headers, rows 0-1 = title.
for i, row in df.iterrows():
    if i < 3:
        continue
    c1_raw = row[1] if 1 < len(row) else None
    c2_raw = row[2] if 2 < len(row) else None
    c3_raw = row[3] if 3 < len(row) else None
    c4_raw = row[4] if 4 < len(row) else None
    c5_raw = row[5] if 5 < len(row) else None

    if pd.isna(c1_raw):
        continue
    c1 = str(c1_raw).strip()
    if not c1:
        continue

    # Category header: has clave but NOT a numeric cantidad (c4)
    is_num = isinstance(c4_raw, (int, float)) and not pd.isna(c4_raw)

    if not is_num:
        # Could be a header row or a stray
        if c1 in ('Material', 'Mano de Obra', 'Herramienta', 'Equipo', 'Contrato', 'Flete'):
            current_cat = c1
        continue

    if current_cat is None:
        # Orphan insumo before any header — skip
        continue

    desc = str(c2_raw).strip() if pd.notna(c2_raw) else ''
    unidad = str(c3_raw).strip() if pd.notna(c3_raw) else 'pza'
    try:
        cantidad = float(c4_raw)
        costo = float(c5_raw) if pd.notna(c5_raw) else 0.0
    except Exception:
        continue

    rows.append({
        'codigo': c1,
        'descripcion': desc,
        'unidad': unidad,
        'categoria': current_cat,
        'cantidad_total': cantidad,
        'costo': costo,
    })

print(json.dumps(rows, ensure_ascii=False))
`;
  const tmp = join(tmpdir(), `tp-insumos-${process.pid}.py`);
  writeFileSync(tmp, py, "utf8");
  try {
    const out = execSync(
      `python3 ${JSON.stringify(tmp)} ${JSON.stringify(EXCEL_PATH)}`,
      { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }
    );
    return JSON.parse(out);
  } finally {
    try { unlinkSync(tmp); } catch { /* */ }
  }
}

async function main() {
  console.log("\n═══ Import Decolsa Insumos ═══\n");

  const company = await prisma.company.findUnique({
    where: { rfc: DECOLSA_RFC },
    select: { id: true, razonSocial: true },
  });
  if (!company) throw new Error("Decolsa company not found");
  console.log(`✓ Company: ${company.razonSocial}`);

  const rows = parseExcel();
  console.log(`✓ Parsed ${rows.length} insumo rows from INSUMOS sheet`);

  const byCat = {};
  for (const r of rows) byCat[r.categoria] = (byCat[r.categoria] ?? 0) + 1;
  for (const [c, n] of Object.entries(byCat)) console.log(`    ${c.padEnd(20)} ${n}`);

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const seenCodes = new Set();

  for (const r of rows) {
    if (seenCodes.has(r.codigo)) {
      // Dup within the sheet — keep first seen, skip rest (typically all same)
      skipped++;
      continue;
    }
    seenCodes.add(r.codigo);

    const tipo = CATEGORY_TO_TIPO[r.categoria];
    if (!tipo) {
      console.warn(`  ⚠ unknown categoria: ${r.categoria} — skipping ${r.codigo}`);
      skipped++;
      continue;
    }

    const existing = await prisma.insumo.findFirst({
      where: { companyId: company.id, codigo: r.codigo },
      select: { id: true },
    });
    if (existing) {
      await prisma.insumo.update({
        where: { id: existing.id },
        data: {
          descripcion: r.descripcion || r.codigo,
          unidad: r.unidad,
          tipo,
          costoActual: r.costo,
        },
      });
      updated++;
    } else {
      await prisma.insumo.create({
        data: {
          companyId: company.id,
          codigo: r.codigo,
          descripcion: r.descripcion || r.codigo,
          unidad: r.unidad,
          tipo,
          costoActual: r.costo,
        },
      });
      created++;
    }
  }

  console.log(`\n─── Summary ────────────────────────`);
  console.log(`  Insumos creados:    ${created}`);
  console.log(`  Insumos actualizados: ${updated}`);
  console.log(`  Skipped (dup/unknown): ${skipped}`);
  console.log(`  Total en catálogo:  ${created + updated}`);
  console.log();

  // Sanity: list a few by category
  for (const t of ["MATERIAL", "MANO_OBRA", "HERRAMIENTA", "EQUIPO", "BASICO"]) {
    const count = await prisma.insumo.count({ where: { companyId: company.id, tipo: t } });
    const sample = await prisma.insumo.findMany({
      where: { companyId: company.id, tipo: t },
      select: { codigo: true, descripcion: true, unidad: true, costoActual: true },
      take: 2,
    });
    console.log(`  ${t.padEnd(12)} ${count}`);
    for (const s of sample) {
      console.log(`    · ${s.codigo.padEnd(16)} ${s.descripcion.slice(0, 40).padEnd(42)} ${s.unidad} $${s.costoActual.toFixed(2)}`);
    }
  }
  console.log();
}

main()
  .catch((e) => { console.error("❌", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
