/**
 * Presupuesto XLS/XLSX parser — Decolsa's "Master Presupuesto" import.
 *
 * Gerardo's template (ref: PRESUPUESTO DE CONTRATO T05 Y T06 - PROTOTIPO 2R)
 * has three sheets we care about:
 *
 *   • CARÁTULA  — top-level summary (30 capítulos + subtotal + utilidad +
 *                  total). Used for cross-checking only.
 *   • PRESUPUESTO — the actual tree:
 *       Col A: Clave    — branch code "1.1.3.5.1" OR concepto code "ACERO04"
 *       Col B: Descripción
 *       Col C: Unidad   (leaves only)
 *       Col D: Cantidad (leaves only)
 *       Col E: Precio unitario (leaves only)
 *       Col F: Total    (leaves: Q×PU; branches: rollup)
 *       Col G: %        (auto, not stored)
 *   • INSUMOS   — pre-computed insumo explosion. Used to seed the Insumo
 *                  catalog on first import.
 *
 * Tree assembly: stack-based. Walk PRESUPUESTO rows in order. Each branch
 * pushes / replaces ancestors based on its dotted code. Leaves attach to
 * the deepest open branch.
 *
 * The parser is pure: takes a Buffer, returns a structured object. No DB
 * writes, no I/O. The /scan endpoint runs this; /import consumes the result.
 */

import * as XLSX from "xlsx";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ParsedPresupuestoBranch = {
  kind: "branch";
  codigo: string;        // "1", "1.1", "1.1.3.5.1"
  nivel: number;         // 1-indexed depth
  descripcion: string;
  importeReportado: number; // value from Excel column F (rollup); we recompute
  rowIndex: number;      // for warning messages
};

export type ParsedPresupuestoLeaf = {
  kind: "leaf";
  parentCodigo: string | null; // dotted code of nearest branch ancestor
  conceptoClave: string;       // alphanumeric, e.g. "PUACE030"
  descripcion: string;
  unidad: string;
  cantidad: number;
  precioUnitario: number;
  importe: number;
  rowIndex: number;
};

export type ParsedInsumo = {
  clave: string;
  descripcion: string;
  unidad: string;
  costoActual: number;
  familia: string | null;
  tipo: "MATERIAL" | "MANO_OBRA" | "EQUIPO" | "HERRAMIENTA" | "BASICO";
};

export type ParsedCaratula = {
  titulo: string | null;
  subtotal: number | null;
  utilidad: number | null;
  total: number | null;
};

export type PresupuestoParseResult = {
  caratula: ParsedCaratula;
  branches: ParsedPresupuestoBranch[];
  leaves: ParsedPresupuestoLeaf[];
  insumos: ParsedInsumo[];
  warnings: string[];
  totals: {
    branchCount: number;
    leafCount: number;
    maxDepth: number;
    sumLeafImporte: number;     // Σ leaf.importe — the "real" presupuesto total
    sumBranchTopImporte: number; // Σ depth-1 branches importeReportado (cross-check)
  };
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BRANCH_CODE_RE = /^\d+(\.\d+)*$/;

function depthOf(codigo: string): number {
  return codigo.split(".").filter(Boolean).length;
}

/**
 * Normalize a clave from CARÁTULA (often "1.0", "2.0") to the same form used
 * in PRESUPUESTO (just "1", "2"). Trailing ".0" is cosmetic — strip it so
 * the cross-check matches.
 */
function normalizeCaratulaCode(s: string): string {
  return s.replace(/\.0+$/, "");
}

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const cleaned = v.replace(/[,\s$]/g, "");
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toStr(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

// ─── PRESUPUESTO sheet ───────────────────────────────────────────────────────

function parsePresupuestoSheet(
  rows: unknown[][],
  warnings: string[]
): { branches: ParsedPresupuestoBranch[]; leaves: ParsedPresupuestoLeaf[] } {
  const branches: ParsedPresupuestoBranch[] = [];
  const leaves: ParsedPresupuestoLeaf[] = [];

  // Stack of currently-open branches (deepest last). Used to find the parent
  // of incoming rows. When a new branch arrives, we pop ancestors that aren't
  // a strict prefix of the new code.
  let stack: ParsedPresupuestoBranch[] = [];

  // Track concepto descriptions across the file. If the same clave appears
  // with diverging descriptions, warn — usually a Gerardo typo.
  const conceptoDescs = new Map<string, string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const claveRaw = toStr(row[0]);
    if (!claveRaw) continue;
    const desc = toStr(row[1]);

    // Branch detection: dotted-numeric clave with no cantidad/PU.
    const isBranchShape = BRANCH_CODE_RE.test(claveRaw);
    const cantidad = toNum(row[3]);
    const precioUnitario = toNum(row[4]);

    if (isBranchShape && cantidad == null && precioUnitario == null) {
      const codigo = normalizeCaratulaCode(claveRaw); // tolerate "1.0"
      const nivel = depthOf(codigo);
      const importeReportado = toNum(row[5]) ?? 0;

      // Reconcile the stack: pop ancestors that aren't prefixes of this code.
      // Prefix test is on the dotted-segment level: "1.1.3" is parent of "1.1.3.5"
      // but NOT of "1.1.4" (sibling) — pop until top is prefix.
      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (codigo.startsWith(top.codigo + ".") && nivel > top.nivel) break;
        stack.pop();
      }

      const branch: ParsedPresupuestoBranch = {
        kind: "branch",
        codigo,
        nivel,
        descripcion: desc,
        importeReportado,
        rowIndex: i,
      };
      branches.push(branch);
      stack.push(branch);
      continue;
    }

    // Leaf detection: anything else with a numeric cantidad. We require
    // BOTH cantidad and PU to be parseable; otherwise it's noise (header,
    // blank, summary line) and we skip with a warning.
    if (cantidad == null || precioUnitario == null) {
      // Skip silently — most blanks are decorative section spacers.
      continue;
    }

    if (claveRaw === "" || claveRaw.length > 40) {
      warnings.push(
        `Fila ${i + 1}: Clave inválida ("${claveRaw.slice(0, 30)}"), se omitió.`
      );
      continue;
    }

    const importe = toNum(row[5]) ?? cantidad * precioUnitario;
    const expected = cantidad * precioUnitario;
    if (Math.abs(importe - expected) > Math.max(0.05, expected * 0.001)) {
      warnings.push(
        `Fila ${i + 1} (${claveRaw}): importe ${importe.toFixed(
          2
        )} ≠ cantidad × PU ${expected.toFixed(2)}.`
      );
    }

    const parent = stack.length > 0 ? stack[stack.length - 1] : null;
    if (!parent) {
      warnings.push(
        `Fila ${i + 1} (${claveRaw}): leaf sin capítulo padre, se omitió.`
      );
      continue;
    }

    // Track description divergence
    const prior = conceptoDescs.get(claveRaw);
    if (prior && prior !== desc && prior.length > 0 && desc.length > 0) {
      // Only warn the first time per clave to keep noise down
      if (!warnings.some((w) => w.includes(`Concepto ${claveRaw}: descripciones distintas`))) {
        warnings.push(
          `Concepto ${claveRaw}: descripciones distintas en el archivo (se conservará la primera).`
        );
      }
    } else if (!prior) {
      conceptoDescs.set(claveRaw, desc);
    }

    leaves.push({
      kind: "leaf",
      parentCodigo: parent.codigo,
      conceptoClave: claveRaw,
      descripcion: prior ?? desc,
      unidad: toStr(row[2]),
      cantidad,
      precioUnitario,
      importe,
      rowIndex: i,
    });
  }

  return { branches, leaves };
}

// ─── CARÁTULA sheet (cross-check only) ───────────────────────────────────────

function parseCaratulaSheet(rows: unknown[][]): ParsedCaratula {
  let titulo: string | null = null;
  let subtotal: number | null = null;
  let utilidad: number | null = null;
  let total: number | null = null;

  for (const row of rows) {
    const a = toStr(row[0]);
    const e = toStr(row[4]);
    const f = toNum(row[5]);
    if (!titulo && a && /presupuesto/i.test(a)) titulo = a;
    if (e && f != null) {
      if (/SUBTOTAL/i.test(e)) subtotal = f;
      else if (/Utilidad/i.test(e)) utilidad = f;
      else if (/IMPORTE\s+TOTAL/i.test(e)) total = f;
    }
  }
  return { titulo, subtotal, utilidad, total };
}

// ─── INSUMOS sheet ───────────────────────────────────────────────────────────

function parseInsumosSheet(
  rows: unknown[][],
  warnings: string[]
): ParsedInsumo[] {
  const out: ParsedInsumo[] = [];

  // The sheet has section headers like "Tipo: Materiales" — track current
  // section as we walk so we can tag each insumo with the right tipo.
  let currentTipo: ParsedInsumo["tipo"] = "MATERIAL";

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const a = toStr(row[0]);
    const b = toStr(row[1]);

    // Section header
    if (a.toLowerCase().startsWith("tipo:")) {
      const t = a.slice(5).trim().toLowerCase();
      if (t.startsWith("material")) currentTipo = "MATERIAL";
      else if (t.startsWith("mano")) currentTipo = "MANO_OBRA";
      else if (t.startsWith("equipo") || t.startsWith("maquin")) currentTipo = "EQUIPO";
      else if (t.startsWith("herr")) currentTipo = "HERRAMIENTA";
      else if (t.startsWith("básic") || t.startsWith("basic")) currentTipo = "BASICO";
      continue;
    }

    if (!a || !b) continue;
    if (a === "Clave" || /clave/i.test(a)) continue; // header row

    const unidad = toStr(row[2]);
    const costoActual = toNum(row[4]);
    if (costoActual == null) continue;
    const familia = toStr(row[7]) || null;

    out.push({
      clave: a,
      descripcion: b,
      unidad: unidad || "pza",
      costoActual,
      familia,
      tipo: currentTipo,
    });
  }

  // Detect duplicate claves with diverging costs — warn but keep first
  const seen = new Map<string, number>();
  const deduped: ParsedInsumo[] = [];
  for (const ins of out) {
    if (seen.has(ins.clave)) {
      const idx = seen.get(ins.clave)!;
      const prior = deduped[idx];
      if (Math.abs(prior.costoActual - ins.costoActual) > 0.01) {
        warnings.push(
          `Insumo ${ins.clave}: costo distinto en la hoja INSUMOS (${prior.costoActual} vs ${ins.costoActual}), se conservó el primero.`
        );
      }
      continue;
    }
    seen.set(ins.clave, deduped.length);
    deduped.push(ins);
  }

  return deduped;
}

// ─── Top-level ───────────────────────────────────────────────────────────────

export function parsePresupuestoXls(buffer: Buffer): PresupuestoParseResult {
  const warnings: string[] = [];

  const wb = XLSX.read(buffer, { type: "buffer", cellDates: false });

  // Find sheets case-insensitively — Gerardo's templates sometimes drift
  // between "PRESUPUESTO" / "Presupuesto" / "PRESUPUESTO 2R" etc.
  function findSheet(needle: string): unknown[][] | null {
    const name = wb.SheetNames.find((n) => n.toUpperCase().includes(needle));
    if (!name) return null;
    const sheet = wb.Sheets[name];
    return XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: null,
      raw: true,
      blankrows: false,
    });
  }

  const presupuestoRows = findSheet("PRESUPUESTO");
  if (!presupuestoRows) {
    throw new Error(
      `No se encontró la hoja "PRESUPUESTO" (hojas: ${wb.SheetNames.join(", ")}).`
    );
  }
  const caratulaRows = findSheet("CARÁTULA") ?? findSheet("CARATULA") ?? [];
  const insumosRows = findSheet("INSUMOS") ?? [];

  const caratula = parseCaratulaSheet(caratulaRows);
  const { branches, leaves } = parsePresupuestoSheet(presupuestoRows, warnings);
  const insumos = parseInsumosSheet(insumosRows, warnings);

  // Totals
  const sumLeafImporte = leaves.reduce((a, l) => a + l.importe, 0);
  const sumBranchTopImporte = branches
    .filter((b) => b.nivel === 1)
    .reduce((a, b) => a + b.importeReportado, 0);
  const maxDepth = branches.reduce((m, b) => Math.max(m, b.nivel), 0);

  // Cross-check: sum of leaves vs CARÁTULA subtotal. Warn (don't fail) on drift.
  if (caratula.subtotal != null) {
    const drift = Math.abs(caratula.subtotal - sumLeafImporte);
    if (drift > Math.max(1, sumLeafImporte * 0.001)) {
      warnings.push(
        `Subtotal CARÁTULA ($${caratula.subtotal.toFixed(2)}) difiere de la suma de leaves ($${sumLeafImporte.toFixed(2)}) por $${drift.toFixed(2)}.`
      );
    }
  }

  // Sanity: every leaf has a parent in the branches list
  const branchCodes = new Set(branches.map((b) => b.codigo));
  for (const l of leaves) {
    if (l.parentCodigo && !branchCodes.has(l.parentCodigo)) {
      warnings.push(
        `Concepto ${l.conceptoClave}: padre "${l.parentCodigo}" no está en el árbol.`
      );
    }
  }

  return {
    caratula,
    branches,
    leaves,
    insumos,
    warnings,
    totals: {
      branchCount: branches.length,
      leafCount: leaves.length,
      maxDepth,
      sumLeafImporte,
      sumBranchTopImporte,
    },
  };
}
