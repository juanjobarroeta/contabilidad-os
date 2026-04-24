/**
 * Seed Decolsa's Torres Platino prototype presupuesto from the
 * partner's Excel file:
 *
 *   /Users/juanjosebarroeta/Downloads/1.- PRESUPUESTO - PROTOTIPO 3R  - TORRES PLATINO 300623.xls
 *
 * Structure in the Excel (sheet "PRESUPUESTO"):
 *
 *   Clave         Descripción                Unidad  Cantidad  Costo   Total   %
 *   1.0           LOSA DE CIMENTACIÓN                                  767065
 *   1.1           LOSA DE CIMENTACIÓN                                  710132
 *   1.1.1         PRELIMINARES-CIMENTACIÓN                              38363
 *   TRAZEQU01     TRAZO Y NIVELACIÓN DEL…    m2      497.13   10.53    5234
 *   …
 *
 * Rows with dotted-number claves (`1`, `1.1`, `1.1.3.1`) are Capítulo
 * BRANCHES (esRollup=true). Rows with alphanumeric claves (`TRAZEQU01`)
 * are LEAVES that reference a Concepto.
 *
 * What the script does:
 *
 *   1. Parses the Excel via Python (pandas) — same pattern as
 *      import-matrices.mjs, which is already proven.
 *   2. Upserts the Proyecto "TP01 Torres Platino" for Decolsa.
 *   3. Wipes any existing presupuesto on that proyecto (idempotent).
 *   4. Upserts Concepto rows for every distinct leaf clave, including
 *      a minimal APU so precioUnitario is set. No insumos — can be
 *      imported later via a matrices script if Decolsa provides one.
 *   5. Creates a BORRADOR Presupuesto with the full capítulo tree:
 *        - Branches (esRollup=true) with nivel + codigo + parentPartidaId
 *        - Leaves with cantidad + precioUnitario + importe and parentPartidaId
 *          pointing at the deepest active branch
 *   6. Verifies the recomputed montoTotal against the Excel grand total.
 *
 * Usage:
 *   cd /Users/juanjosebarroeta/Documents/contabilidad-os
 *   set -a; . ./.env.local; set +a
 *   node scripts/seed-torres-platino.mjs
 */

import { PrismaClient } from "@prisma/client";
import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const prisma = new PrismaClient();

const DECOLSA_RFC = "DIN1604261F8";
const PROYECTO_CODIGO = "TP01";
const PROYECTO_NOMBRE = "Torres Platino";
const EXCEL_PATH =
  "/Users/juanjosebarroeta/Downloads/1.- PRESUPUESTO - PROTOTIPO 3R  - TORRES PLATINO 300623.xls";

const round2 = (n) => Math.round(n * 100) / 100;
const log = (...a) => console.log(...a);

// ── 1. Parse via Python ─────────────────────────────────────────────────
function parseExcel() {
  const py = `
import pandas as pd, json, sys, math, re

f = sys.argv[1]
df = pd.read_excel(f, sheet_name='PRESUPUESTO', header=None)

def cell(row, j):
    v = row[j] if j < len(row) else None
    if pd.isna(v): return None
    if isinstance(v, str):
        s = v.strip()
        return s if s else None
    return v

BRANCH_RE = re.compile(r'^[0-9]+(\\.[0-9]+)*$')

rows = []
for _, row in df.iterrows():
    clave = cell(row, 1)
    desc = cell(row, 2)
    unidad = cell(row, 3)
    cantidad = cell(row, 4)
    costo = cell(row, 5)
    total = cell(row, 6)
    if clave is None and desc is None:
        continue
    clave_s = str(clave).strip() if clave is not None else ''
    is_branch = bool(BRANCH_RE.match(clave_s)) if clave_s else False
    # Some totals/title rows have no clave and no cantidad — skip them
    # (we only want real branches + real leaves).
    if not clave_s:
        continue
    # Skip rows that have neither costo nor total — malformed separators
    if is_branch:
        rows.append({
            'kind': 'branch',
            'codigo': clave_s,
            'descripcion': desc or '',
            'total': float(total) if isinstance(total, (int, float)) and not pd.isna(total) else 0.0,
        })
    else:
        # Leaf: require cantidad + costo
        if cantidad is None or costo is None:
            continue
        try:
            q = float(cantidad)
            pu = float(costo)
        except Exception:
            continue
        rows.append({
            'kind': 'leaf',
            'codigo': clave_s,
            'descripcion': desc or '',
            'unidad': (unidad or '').strip() or 'pza',
            'cantidad': q,
            'precioUnitario': pu,
            'importe': float(total) if isinstance(total, (int, float)) and not pd.isna(total) else round(q * pu, 2),
        })

print(json.dumps(rows, ensure_ascii=False))
`;
  log("Parsing Torres Platino Excel…");
  const tmpPy = join(tmpdir(), `tp-parse-${process.pid}.py`);
  writeFileSync(tmpPy, py, "utf8");
  try {
    const out = execSync(`python3 ${JSON.stringify(tmpPy)} ${JSON.stringify(EXCEL_PATH)}`, {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
    return JSON.parse(out);
  } finally {
    try { unlinkSync(tmpPy); } catch { /* ignore */ }
  }
}

// ── 2. Main ─────────────────────────────────────────────────────────────
async function main() {
  log("\n═══ Seed Torres Platino ═══\n");

  const company = await prisma.company.findUnique({
    where: { rfc: DECOLSA_RFC },
    select: { id: true, razonSocial: true },
  });
  if (!company) {
    console.error(`❌ Decolsa Company (${DECOLSA_RFC}) not found — run create-decolsa-company.mjs first.`);
    process.exit(1);
  }
  log(`✓ Company: ${company.razonSocial}`);

  const rows = parseExcel();
  const branches = rows.filter((r) => r.kind === "branch");
  const leaves = rows.filter((r) => r.kind === "leaf");
  log(`✓ Parsed ${branches.length} branches + ${leaves.length} leaves`);

  // ── Proyecto upsert ────────────────────────────────────────────────
  let proyecto = await prisma.proyecto.findUnique({
    where: { companyId_codigo: { companyId: company.id, codigo: PROYECTO_CODIGO } },
  });
  if (!proyecto) {
    proyecto = await prisma.proyecto.create({
      data: {
        companyId: company.id,
        codigo: PROYECTO_CODIGO,
        nombre: PROYECTO_NOMBRE,
        descripcion: 'Prototipo 3R — presupuesto por torre (templatizado)',
        ubicacion: 'Puebla, Pue.',
        tipo: "PRIVADO",
        estado: "PLANEACION",
      },
    });
    log(`✓ Created Proyecto: ${proyecto.codigo} ${proyecto.nombre}`);
  } else {
    log(`✓ Proyecto already exists: ${proyecto.codigo}`);
  }

  // ── Wipe any existing presupuesto on this proyecto (idempotent reseed) ─
  const existingPres = await prisma.presupuesto.findMany({
    where: { proyectoId: proyecto.id },
    select: { id: true, nombre: true },
  });
  if (existingPres.length > 0) {
    log(`  Wiping ${existingPres.length} existing presupuesto(s)…`);
    // Delete partidas first (parent self-FK will cascade via nested deletes)
    for (const p of existingPres) {
      // Clear parentPartidaId refs so we can delete leaves first, then branches
      await prisma.presupuestoPartida.updateMany({
        where: { presupuestoId: p.id },
        data: { parentPartidaId: null },
      });
      await prisma.presupuestoPartida.deleteMany({ where: { presupuestoId: p.id } });
      await prisma.presupuesto.delete({ where: { id: p.id } });
    }
  }

  // ── Upsert Concepto rows for every leaf clave ────────────────────
  // Group by unique codigo; multiple leaf rows may share a Concepto (same
  // clave repeated across partidas). We use the first seen row as the
  // authoritative description/unidad/PU.
  const conceptoByCodigo = new Map();
  for (const leaf of leaves) {
    if (!conceptoByCodigo.has(leaf.codigo)) {
      conceptoByCodigo.set(leaf.codigo, leaf);
    }
  }
  log(`  Upserting ${conceptoByCodigo.size} Concepto rows…`);

  const conceptoIdByCodigo = new Map();
  for (const [codigo, leaf] of conceptoByCodigo.entries()) {
    // Upsert the Concepto and ensure there's an APU + apuActual pointer so
    // precioUnitario has a canonical home. APU has no insumos yet — an
    // explosion won't decompose these, but avance/estimaciones work fine.
    const existingConcepto = await prisma.concepto.findFirst({
      where: { companyId: company.id, codigo },
      select: { id: true, apuActualId: true },
    });
    if (existingConcepto) {
      conceptoIdByCodigo.set(codigo, existingConcepto.id);
      // Refresh the PU on the existing apuActual if one exists (don't re-create)
      if (existingConcepto.apuActualId) {
        await prisma.aPU.update({
          where: { id: existingConcepto.apuActualId },
          data: { precioUnitario: leaf.precioUnitario, costoDirecto: leaf.precioUnitario },
        });
      }
      continue;
    }
    const c = await prisma.concepto.create({
      data: {
        companyId: company.id,
        codigo,
        descripcion: leaf.descripcion.slice(0, 300),
        unidad: leaf.unidad,
      },
    });
    const apu = await prisma.aPU.create({
      data: {
        companyId: company.id,
        conceptoId: c.id,
        version: 1,
        costoDirecto: leaf.precioUnitario,
        precioUnitario: leaf.precioUnitario,
      },
    });
    await prisma.concepto.update({
      where: { id: c.id },
      data: { apuActualId: apu.id },
    });
    conceptoIdByCodigo.set(codigo, c.id);
  }

  // ── Create Presupuesto + tree ────────────────────────────────────
  const presupuesto = await prisma.presupuesto.create({
    data: {
      companyId: company.id,
      proyectoId: proyecto.id,
      nombre: "Prototipo Torres Platino",
      version: 1,
      estado: "BORRADOR",
      montoTotal: 0,
      tipoPresupuesto: "CONTRATO",
    },
  });
  log(`✓ Created Presupuesto: ${presupuesto.nombre}`);

  // Walk the rows in order. For each branch, compute level from number
  // of dots. Maintain a stack of (level → partidaId) so we can look up
  // the parent for any new branch or leaf.
  const branchIdByCodigo = new Map();
  const activeBranchAtLevel = new Map(); // level (int) → PresupuestoPartida.id
  let orden = 0;
  let inserted = 0;
  let leafTotal = 0;

  // Walk in original order: branches set context, leaves consume it.
  for (const r of rows) {
    if (r.kind === "branch") {
      const level = r.codigo.split(".").length - 1; // "1" → 0; "1.1" → 1; "1.1.3" → 2
      // Parent = deepest active branch shallower than this level
      let parentId = null;
      for (let l = level - 1; l >= 0; l--) {
        if (activeBranchAtLevel.has(l)) {
          parentId = activeBranchAtLevel.get(l);
          break;
        }
      }
      const created = await prisma.presupuestoPartida.create({
        data: {
          presupuestoId: presupuesto.id,
          conceptoId: null,
          apuVersion: 1,
          cantidad: null,
          precioUnitario: 0,
          importe: 0,
          orden: orden++,
          parentPartidaId: parentId,
          nivel: level,
          codigo: r.codigo,
          partida: r.descripcion.slice(0, 200),
          esRollup: true,
        },
        select: { id: true },
      });
      branchIdByCodigo.set(r.codigo, created.id);
      activeBranchAtLevel.set(level, created.id);
      // Invalidate any deeper levels — new branch at `level` starts a fresh subtree
      for (const k of [...activeBranchAtLevel.keys()]) {
        if (k > level) activeBranchAtLevel.delete(k);
      }
      inserted++;
    } else {
      const conceptoId = conceptoIdByCodigo.get(r.codigo);
      if (!conceptoId) continue;
      // Parent = deepest currently active branch
      let parentId = null;
      let parentLevel = -1;
      for (const [l, id] of activeBranchAtLevel.entries()) {
        if (l > parentLevel) {
          parentLevel = l;
          parentId = id;
        }
      }
      await prisma.presupuestoPartida.create({
        data: {
          presupuestoId: presupuesto.id,
          conceptoId,
          apuVersion: 1,
          cantidad: r.cantidad,
          precioUnitario: r.precioUnitario,
          importe: round2(r.importe),
          orden: orden++,
          parentPartidaId: parentId,
          nivel: parentLevel + 1,
          // Leaf codigo piggybacks on the concepto code for readability
          codigo: null,
          partida: null,
          esRollup: false,
        },
      });
      leafTotal += round2(r.importe);
      inserted++;
    }
  }
  log(`✓ Inserted ${inserted} partidas (${branchIdByCodigo.size} branches, ${leaves.length} leaves)`);

  // Recompute montoTotal from leaves only
  const montoTotal = round2(leafTotal);
  await prisma.presupuesto.update({
    where: { id: presupuesto.id },
    data: { montoTotal },
  });
  log(`✓ montoTotal = ${montoTotal.toLocaleString("es-MX", { style: "currency", currency: "MXN" })}`);

  log(`\n─── Verify ─────────────────────────`);
  log(`  Excel grand total (row "TORRES PLATINO…"): $15,515,510.09`);
  log(`  Computed sum of leaves:                  ${montoTotal.toLocaleString("es-MX", { style: "currency", currency: "MXN" })}`);
  const diff = Math.abs(montoTotal - 15515510.09);
  log(`  Difference:                               ${diff.toFixed(2)}${diff < 100 ? "  ✓" : "  ⚠ (check for missed rows)"}`);
  log();
  log(`Next: Gerardo logs in, opens Torres Platino → Presupuestos → "Prototipo Torres Platino"`);
  log(`      to verify the tree renders correctly. Unidades (torres + deptos) can be`);
  log(`      created from the Unidades tab in the UI.`);
  log();
}

main()
  .catch((e) => {
    console.error("❌", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
