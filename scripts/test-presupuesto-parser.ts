/**
 * Smoke test for the presupuesto parser against Gerardo's real Torres Platino
 * Excel. Compares parser output to known-good numbers from the analysis we
 * did inline. Run with:
 *
 *   set -a && source .env.local && set +a && \
 *     node --import tsx scripts/test-presupuesto-parser.mjs
 *
 * Expects the file at the path baked in below (download path).
 */
import { readFileSync } from "node:fs";
import { parsePresupuestoXls } from "../src/lib/construccion/presupuesto-parser.js";

const FILE =
  "/Users/juanjosebarroeta/Downloads/1.- PRESUPUESTO DE CONTRATO T05 Y T06 - PROTOTIPO 2R  - TORRES PLATINO 060824.xls";

const buf = readFileSync(FILE);
const result = parsePresupuestoXls(buf);

console.log("=== CARÁTULA ===");
console.log(result.caratula);

console.log("\n=== TOTALS ===");
console.log(result.totals);

console.log(`\n=== BRANCHES BY DEPTH ===`);
const byDepth = new Map();
for (const b of result.branches) {
  byDepth.set(b.nivel, (byDepth.get(b.nivel) ?? 0) + 1);
}
for (const [d, n] of [...byDepth.entries()].sort()) {
  console.log(`  depth ${d}: ${n}`);
}

console.log(`\n=== FIRST 3 BRANCHES ===`);
for (const b of result.branches.slice(0, 3)) {
  console.log(`  [${b.codigo}] ${b.descripcion} → reportado $${b.importeReportado}`);
}

console.log(`\n=== FIRST 3 LEAVES ===`);
for (const l of result.leaves.slice(0, 3)) {
  console.log(
    `  parent=${l.parentCodigo} clave=${l.conceptoClave} ${l.unidad} ${l.cantidad}×${l.precioUnitario} = $${l.importe.toFixed(2)} — ${l.descripcion.slice(0, 50)}`
  );
}

console.log(`\n=== INSUMOS ===`);
console.log(`  total: ${result.insumos.length}`);
const tipoCounts = new Map();
for (const i of result.insumos) {
  tipoCounts.set(i.tipo, (tipoCounts.get(i.tipo) ?? 0) + 1);
}
for (const [t, n] of tipoCounts) console.log(`  ${t}: ${n}`);

console.log(`\n=== WARNINGS (${result.warnings.length}) ===`);
for (const w of result.warnings.slice(0, 20)) console.log(`  • ${w}`);
if (result.warnings.length > 20) console.log(`  …+${result.warnings.length - 20} more`);

// Assertions
const expected = {
  branchCount: 30 + 110 + 210 + 206 + 118 + 24, // 698 (incl. depth 6)
  leafCount: 1392,
  maxDepth: 6,
};
console.log(`\n=== ASSERTIONS ===`);
const ok = (cond: boolean, msg: string) => console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
ok(result.totals.branchCount === expected.branchCount, `branchCount = ${expected.branchCount}`);
ok(result.totals.leafCount === expected.leafCount, `leafCount = ${expected.leafCount}`);
ok(result.totals.maxDepth === expected.maxDepth, `maxDepth = ${expected.maxDepth}`);
ok(
  Math.abs(result.totals.sumLeafImporte - 11956840.98) < 0.01,
  `sumLeafImporte ≈ $11,956,840.98`
);
ok(
  result.caratula.subtotal != null && Math.abs(result.caratula.subtotal - 11956840.98) < 0.01,
  `CARÁTULA subtotal matches`
);
ok(
  Math.abs(result.totals.sumBranchTopImporte - result.totals.sumLeafImporte) < 1,
  `Σbranches[depth=1] ≈ Σleaves (tree integrity)`
);
