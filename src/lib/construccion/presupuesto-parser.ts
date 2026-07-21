/**
 * Presupuesto XLS/XLSX parser — Decolsa's "Master Presupuesto" import.
 *
 * Three input formats, auto-detected by sheet names:
 *
 *   1. "PRESUPUESTO" (master) — dotted-code tree + INSUMOS + CARÁTULA.
 *   2. "Matrices" — Opus/Neodata APU export (template Bartiz).
 *   3. "LISTA DE CONCEPTOS" — Gerardo's remodelación format: CARATULA DE
 *      PRESUPUESTO + LISTA DE CONCEPTOS (filas CAPITULO/CONCEPTO agrupadas
 *      por LOCAL) + MATERIALES (explosión con PRECIO / PRECIO CON IVA).
 *
 * Gerardo's master template (ref: PRESUPUESTO DE CONTRATO T05 Y T06 -
 * PROTOTIPO 2R) has three sheets we care about:
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
  cantidad: number;      // project-total quantity from the explosion sheet
  costoActual: number;   // unit price
  importe: number;       // cantidad × costoActual
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

/**
 * Gerardo's exports sometimes carry a leading blank spacer column, so the
 * "Clave / Descripción / Unidad / Cantidad / …" table starts at column B
 * instead of A. Both the PRESUPUESTO and INSUMOS sheets share this layout.
 * Locate the real start column by finding the "Clave" header; default to 0.
 * Every other column is read relative to this base.
 */
function findBaseCol(rows: unknown[][]): number {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const row = rows[i] ?? [];
    for (let c = 0; c < row.length; c++) {
      if (toStr(row[c]).toLowerCase() === "clave") return c;
    }
  }
  return 0;
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

  // Column base — tolerate a leading blank spacer column (data at col B).
  const base = findBaseCol(rows);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const claveRaw = toStr(row[base]);
    if (!claveRaw) continue;
    const desc = toStr(row[base + 1]);

    // Branch detection: dotted-numeric clave with no cantidad/PU.
    const isBranchShape = BRANCH_CODE_RE.test(claveRaw);
    const cantidad = toNum(row[base + 3]);
    const precioUnitario = toNum(row[base + 4]);

    if (isBranchShape && cantidad == null && precioUnitario == null) {
      const codigo = normalizeCaratulaCode(claveRaw); // tolerate "1.0"
      const nivel = depthOf(codigo);
      const importeReportado = toNum(row[base + 5]) ?? 0;

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

    const importe = toNum(row[base + 5]) ?? cantidad * precioUnitario;
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
      unidad: toStr(row[base + 2]),
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

// ─── INSUMOS / Explosión de Insumos sheet ─────────────────────────────────
//
// Column layout (Gerardo's template, "Explosión de recursos de presupuesto"):
//   Col A (0): always blank
//   Col B (1): Clave  (or section name: "Material", "Mano de Obra", …)
//   Col C (2): Descripción  (null on section-header rows)
//   Col D (3): Unidad
//   Col E (4): Cantidad  (project-total quantity for this insumo)
//   Col F (5): Costo    (unit price)
//   Col G (6): Importe  (= Cantidad × Costo)
//   Col H (7): Porcentaje (ignored)
//
// Section headers: col B has a category word, col C is null.
// Recognised sections → InsumoTipo:
//   "Material"     → MATERIAL
//   "Mano de Obra" → MANO_OBRA
//   "Herramienta"  → HERRAMIENTA
//   "Equipo"       → EQUIPO
//   "Contrato"     → BASICO  (subcontracted / assembled items)
//   "Flete"        → BASICO  (freight)
//   "Tipo: …"      → legacy format fallback

function parseInsumosSheet(
  rows: unknown[][],
  warnings: string[]
): ParsedInsumo[] {
  const out: ParsedInsumo[] = [];
  let currentTipo: ParsedInsumo["tipo"] = "MATERIAL";

  // Column base — tolerate a leading blank spacer column (data at col B).
  const base = findBaseCol(rows);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const clave = toStr(row[base]);       // Clave (or section name)
    const desc  = toStr(row[base + 1]);   // Descripción

    if (!clave) continue;

    // Skip the title row and column-header row
    if (/explosión|explosion|recursos/i.test(clave)) continue;
    if (/^clave$/i.test(clave)) continue;

    // Section-header: clave col has a word, descripción col is null/empty
    if (!desc) {
      const low = clave.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
      if (low.startsWith("tipo:")) {
        // Legacy "Tipo: Material" format
        const t = low.slice(5).trim();
        if (t.startsWith("material")) currentTipo = "MATERIAL";
        else if (t.startsWith("mano")) currentTipo = "MANO_OBRA";
        else if (t.startsWith("equipo") || t.startsWith("maquin")) currentTipo = "EQUIPO";
        else if (t.startsWith("herr")) currentTipo = "HERRAMIENTA";
        else currentTipo = "BASICO";
      } else if (low.startsWith("material")) {
        currentTipo = "MATERIAL";
      } else if (low.startsWith("mano")) {
        currentTipo = "MANO_OBRA";
      } else if (low.startsWith("equipo") || low.startsWith("maquin")) {
        currentTipo = "EQUIPO";
      } else if (low.startsWith("herr")) {
        currentTipo = "HERRAMIENTA";
      } else if (low.startsWith("contrato") || low.startsWith("flete") || low.startsWith("basic")) {
        currentTipo = "BASICO";
      }
      // Either way it's a header row — don't emit a record
      continue;
    }

    const unidad   = toStr(row[base + 2]) || "pza";   // Unidad
    const cantidad = toNum(row[base + 3]) ?? 0;        // Cantidad
    const costo    = toNum(row[base + 4]);             // Costo
    if (costo == null) continue;
    const importe  = toNum(row[base + 5]) ?? cantidad * costo; // Importe

    out.push({
      clave,
      descripcion: desc,
      unidad,
      cantidad,
      costoActual: costo,
      importe,
      familia: null,
      tipo: currentTipo,
    });
  }

  // Deduplicate: keep first occurrence; warn on cost divergence
  const seen = new Map<string, number>();
  const deduped: ParsedInsumo[] = [];
  for (const ins of out) {
    if (seen.has(ins.clave)) {
      const prior = deduped[seen.get(ins.clave)!];
      if (Math.abs(prior.costoActual - ins.costoActual) > 0.01) {
        warnings.push(
          `Insumo ${ins.clave}: costo distinto en la hoja INSUMOS (${prior.costoActual} vs ${ins.costoActual}), se conservó el primero.`
        );
      }
      // Accumulate quantities across duplicate claves (e.g. same material in
      // multiple sections of the sheet).
      prior.cantidad += ins.cantidad;
      prior.importe  += ins.importe;
      continue;
    }
    seen.set(ins.clave, deduped.length);
    deduped.push({ ...ins });
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

  // La hoja del árbol se llama "PRESUPUESTO", pero la carátula de otros
  // formatos puede llamarse "CARATULA DE PRESUPUESTO" — excluirla para no
  // parsear la carátula como si fuera el árbol (daría 0 conceptos).
  const presupuestoName = wb.SheetNames.find((n) => {
    const up = n
      .toUpperCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "");
    return up.includes("PRESUPUESTO") && !up.includes("CARATULA");
  });
  const presupuestoRows = presupuestoName
    ? XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[presupuestoName], {
        header: 1,
        defval: null,
        raw: true,
        blankrows: false,
      })
    : null;
  if (!presupuestoRows) {
    // Formato "LISTA DE CONCEPTOS" (remodelaciones de Gerardo): filas
    // CAPITULO/CONCEPTO agrupadas por LOCAL + hoja MATERIALES como explosión.
    const conceptosRows = findSheet("CONCEPTOS");
    if (conceptosRows) {
      const caratulaRows = findSheet("CARÁTULA") ?? findSheet("CARATULA") ?? [];
      const materialesRows = findSheet("MATERIALES") ?? findSheet("INSUMOS") ?? [];
      return parseListaConceptosResult(conceptosRows, materialesRows, caratulaRows, warnings);
    }
    // Formato alterno: "Matrices" (export estilo Opus/Neodata de análisis de
    // precios unitarios — el template de Bartiz). Una sola hoja con bloques
    // por análisis. Se convierte al MISMO PresupuestoParseResult para que
    // todo lo demás (import, explosión, requisiciones) funcione sin cambios.
    const matricesRows = findSheet("MATRICES") ?? findSheet("MATRIZ");
    if (matricesRows) {
      return parseMatricesResult(matricesRows, warnings);
    }
    throw new Error(
      `No se encontró la hoja "PRESUPUESTO", "LISTA DE CONCEPTOS" ni "Matrices" (hojas: ${wb.SheetNames.join(", ")}).`
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

// ─── Formato "Matrices" (Opus/Neodata — template Bartiz) ─────────────────────
//
// Una sola hoja con bloques repetidos por análisis de precio unitario:
//
//   Partida: A            Análisis No.: 10
//   Análisis: DES.-01 | (vacío) | M² | (vacío) | 1.8 | $158.96
//   <descripción del concepto en la(s) fila(s) siguiente(s), col A>
//   MATERIALES
//     <clave> <desc> <unidad> <PU> <*|/> <cantidad> <importe> <%>
//   MANO DE OBRA
//     <cuadrilla header (PU $0.00, sin importe)>
//     <miembros con cantidad por jornada>
//     Importe: …
//     Rendimiento: M²/JOR … <R> <costo/unidad>   ← cantidad efectiva = miembro/R
//   EQUIPO Y HERRAMIENTA / BASICOS
//     (filas %MOx = herramienta/seguridad como % de MO — costo ya incluido en
//      el PU del concepto; se omiten del listado de insumos)
//   (CD)/(CI)/(CF)/(CU)/PRECIO UNITARIO …
//
// Salida: branches = una por letra de Partida (nivel 1); leaves = un concepto
// por análisis (cantidad/PU/importe de la fila "Análisis:"); insumos =
// agregados por clave con cantidad total = Σ (cantidad por unidad × cantidad
// del concepto).

const MATRICES_SECTIONS: Record<string, ParsedInsumo["tipo"]> = {
  "MATERIALES": "MATERIAL",
  "MANO DE OBRA": "MANO_OBRA",
  "EQUIPO Y HERRAMIENTA": "EQUIPO",
  "HERRAMIENTA": "HERRAMIENTA",
  "MAQUINARIA": "EQUIPO",
  "BASICOS": "BASICO",
  "AUXILIARES": "BASICO",
  "SUBCONTRATOS": "BASICO",
};

function parseMatricesResult(
  rows: unknown[][],
  warnings: string[]
): PresupuestoParseResult {
  const branches: ParsedPresupuestoBranch[] = [];
  const leaves: ParsedPresupuestoLeaf[] = [];
  const branchByLetter = new Map<string, ParsedPresupuestoBranch>();

  // Acumulador de insumos por clave.
  type Acc = {
    clave: string;
    descripcion: string;
    unidad: string;
    costoActual: number;
    cantidad: number;
    tipo: ParsedInsumo["tipo"];
  };
  const insumoAcc = new Map<string, Acc>();
  const addInsumo = (
    clave: string,
    descripcion: string,
    unidad: string,
    costo: number,
    perUnitQty: number,
    conceptoQty: number,
    tipo: ParsedInsumo["tipo"]
  ) => {
    if (!(perUnitQty > 0) || !(conceptoQty > 0)) return;
    const cur = insumoAcc.get(clave);
    const add = perUnitQty * conceptoQty;
    if (cur) {
      cur.cantidad += add;
      if (!cur.descripcion && descripcion) cur.descripcion = descripcion;
      if (costo > 0) cur.costoActual = costo;
    } else {
      insumoAcc.set(clave, { clave, descripcion, unidad, costoActual: costo, cantidad: add, tipo });
    }
  };

  let titulo: string | null = null;
  let currentPartida: string | null = null;
  let currentSection: ParsedInsumo["tipo"] | null = null;
  let concepto: ParsedPresupuestoLeaf | null = null;
  let collectingDesc = false;
  // Bloques compuestos (cuadrillas de MO y básicos): sus renglones traen
  // cantidades POR UNIDAD DEL COMPUESTO y se escalan al cerrar el bloque:
  //   "Rendimiento: <unidad>/JOR" → factor = 1/R (unidades por jornada)
  //   "Volumen:"                  → factor = V   (volumen del básico por unidad)
  let buffer: { clave: string; descripcion: string; unidad: string; costo: number; qty: number; tipo: ParsedInsumo["tipo"] }[] = [];
  let buffering = false;

  // Clasifica un miembro de compuesto por su clave (una cuadrilla dentro de un
  // básico sigue siendo mano de obra aunque la sección sea BASICOS).
  const tipoDe = (clave: string, fallback: ParsedInsumo["tipo"]): ParsedInsumo["tipo"] => {
    const c = clave.toUpperCase();
    if (c.startsWith("MO") || /CUADRILLA/.test(c)) return "MANO_OBRA";
    if (c.startsWith("EQ")) return "EQUIPO";
    return fallback;
  };

  const flushBuffer = (factor: number | null, rowIndex: number) => {
    if (buffer.length === 0) { buffering = false; return; }
    if (factor && factor > 0) {
      for (const m of buffer) {
        addInsumo(m.clave, m.descripcion, m.unidad, m.costo, m.qty * factor, concepto?.cantidad ?? 0, m.tipo);
      }
    } else {
      warnings.push(
        `Matrices: bloque compuesto sin fila de Rendimiento/Volumen cerca de la fila ${rowIndex + 1}; sus insumos se omitieron del listado.`
      );
    }
    buffer = [];
    buffering = false;
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const c0 = toStr(row[0]);
    const c1 = toStr(row[1]);

    if (!titulo && c0 === "Obra:") {
      titulo = c1.replace(/[\r\n]+/g, " ").trim() || null;
      continue;
    }

    if (c0 === "Partida:") {
      flushBuffer(null, i);
      collectingDesc = false;
      currentSection = null;
      const letter = c1 || "SIN PARTIDA";
      currentPartida = letter;
      if (!branchByLetter.has(letter)) {
        const b: ParsedPresupuestoBranch = {
          kind: "branch",
          codigo: letter,
          nivel: 1,
          descripcion: `Partida ${letter}`,
          importeReportado: 0,
          rowIndex: i,
        };
        branchByLetter.set(letter, b);
        branches.push(b);
      }
      continue;
    }

    if (c0 === "Análisis:") {
      flushBuffer(null, i);
      currentSection = null;
      const cantidad = toNum(row[5]) ?? 0;
      const importe = toNum(row[6]) ?? 0;
      const pu = cantidad > 0 ? importe / cantidad : importe;
      concepto = {
        kind: "leaf",
        parentCodigo: currentPartida,
        conceptoClave: c1 || `ANALISIS-${i}`,
        descripcion: "",
        unidad: toStr(row[3]),
        cantidad,
        precioUnitario: pu,
        importe,
        rowIndex: i,
      };
      leaves.push(concepto);
      if (currentPartida) {
        const b = branchByLetter.get(currentPartida);
        if (b) b.importeReportado += importe;
      }
      collectingDesc = true;
      continue;
    }

    // Encabezado de sección (MATERIALES / MANO DE OBRA / …): solo col A.
    const sectionKey = Object.keys(MATRICES_SECTIONS).find((k) => c0.toUpperCase() === k);
    if (sectionKey && !toStr(row[2])) {
      flushBuffer(null, i);
      currentSection = MATRICES_SECTIONS[sectionKey];
      collectingDesc = false;
      continue;
    }

    // Descripción del concepto: filas de texto en col A entre "Análisis:" y la
    // primera sección.
    if (collectingDesc && concepto) {
      if (c0 && !c1) {
        concepto.descripcion = concepto.descripcion ? `${concepto.descripcion} ${c0}` : c0;
        continue;
      }
      if (c0 || c1) collectingDesc = false;
      continue;
    }

    // Cierres de bloque compuesto:
    //   "Rendimiento: M²/JOR" (col B) → las cantidades del bloque son por
    //   jornada; factor = 1/R.  "Volumen:" → son por unidad del básico;
    //   factor = V (volumen usado por unidad del concepto).
    if (c1.startsWith("Rendimiento")) {
      const r = toNum(row[5]);
      flushBuffer(r && r > 0 ? 1 / r : null, i);
      continue;
    }
    if (c1.startsWith("Volumen")) {
      flushBuffer(toNum(row[5]), i);
      continue;
    }
    if (c0 === "SUBTOTAL:") {
      flushBuffer(null, i);
      continue;
    }
    if (c1 === "Importe:" || c1.startsWith("(CD)") || c1.startsWith("(CI)") || c1.startsWith("(CF)") || c1.startsWith("(CU)") || c1.startsWith("SUBTOTAL") || c1.startsWith("PRECIO UNITARIO")) {
      continue;
    }

    // Fila de insumo dentro de una sección.
    if (currentSection && concepto && c0) {
      // %MOx (herramienta menor / equipo de seguridad como % de la MO): costo
      // ya incluido en el PU del concepto; no es un insumo requisitable.
      if (c0.startsWith("%")) continue;

      const op = toStr(row[4]);
      const costo = toNum(row[3]) ?? 0;
      const cant = toNum(row[5]) ?? 0;
      const importe = toNum(row[6]);

      // Header de compuesto (cuadrilla o básico): sin operador */, sin importe
      // y sin costo/cantidad reales → los renglones siguientes son sus
      // componentes, escalados al cerrar con Rendimiento/Volumen.
      if (op !== "*" && op !== "/" && (importe == null || importe === 0) && (costo === 0 || cant === 0)) {
        flushBuffer(null, i);
        buffering = true;
        continue;
      }

      const perUnitLocal = op === "/" ? (cant > 0 ? 1 / cant : 0) : cant;
      if (buffering) {
        buffer.push({ clave: c0, descripcion: c1, unidad: toStr(row[2]), costo, qty: perUnitLocal, tipo: tipoDe(c0, currentSection) });
        continue;
      }
      addInsumo(c0, c1, toStr(row[2]), costo, perUnitLocal, concepto.cantidad, currentSection);
    }
  }
  flushBuffer(null, rows.length - 1);

  const insumos: ParsedInsumo[] = [...insumoAcc.values()].map((a) => ({
    clave: a.clave,
    descripcion: a.descripcion,
    unidad: a.unidad,
    cantidad: Math.round(a.cantidad * 10000) / 10000,
    costoActual: a.costoActual,
    importe: Math.round(a.cantidad * a.costoActual * 100) / 100,
    familia: null,
    tipo: a.tipo,
  }));

  const sumLeafImporte = leaves.reduce((s, l) => s + l.importe, 0);
  if (leaves.length === 0) {
    warnings.push('Matrices: no se encontró ningún bloque "Análisis:" — ¿es el formato correcto?');
  }

  return {
    caratula: { titulo, subtotal: null, utilidad: null, total: sumLeafImporte },
    branches,
    leaves,
    insumos,
    warnings,
    totals: {
      branchCount: branches.length,
      leafCount: leaves.length,
      maxDepth: 1,
      sumLeafImporte,
      sumBranchTopImporte: branches.reduce((s, b) => s + b.importeReportado, 0),
    },
  };
}

// ─── Formato "LISTA DE CONCEPTOS" (remodelaciones de Gerardo) ────────────────
//
// Hojas: CARATULA DE PRESUPUESTO / LISTA DE CONCEPTOS / MATERIALES.
//
// LISTA DE CONCEPTOS — columnas: Tipo | Clave | Descripción | Unidad |
// Cantidad | Precio unitario | Total. Filas por tipo (col A):
//   • "CAPITULO n"      → rama. La numeración REINICIA por local, así que el
//                          código se compone: local "1" → capítulos "1.1"…
//   • "CONCEPTO"        → hoja (leaf). La col Clave viene vacía: se genera una
//                          clave determinística a partir de la descripción
//                          (mismo texto → misma clave → mismo concepto de
//                          catálogo entre presupuestos).
//   • (col A vacía) + descripción + Total, sin cantidad/PU → agrupador
//     "LOCAL D/E/F/G" (rama nivel 1). La fila "TOTAL …" de arriba se ignora.
//
// MATERIALES — explosión de insumos: Clave | Descripción | Unidad | Cantidad |
// PRECIO | PRECIO CON IVA | IMPORTE | PORCENTAJE. Filas "TIPO" (nombre de la
// sección en la col Cantidad) separan Herramientas y equipo / Mano de obra /
// Materiales / Contrato. costoActual = PRECIO (sin IVA) e importe se recalcula
// cantidad × precio para mantener todo el sistema a costo directo sin IVA; la
// columna IMPORTE del Excel trae IVA incluido y no se usa. Filas con unidad
// "(%)mo" (herramienta menor / seguridad como % de MO) no son requisitables y
// se omiten, igual que en el formato Matrices.
//
// CARÁTULA — etiquetas en col B, importes en col E. Ojo: en este formato la
// fila "UTILIDAD 16%" es el IVA (mal etiquetada en el template), NO utilidad;
// se ignora para el campo utilidad y el TOTAL ya lo incluye.

/** Clave determinística a partir de la descripción (djb2 → base36). */
function claveFromDescripcion(desc: string): string {
  const s = desc
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return `AUTO-${h.toString(36).toUpperCase()}`;
}

function parseCaratulaLocalesSheet(rows: unknown[][]): ParsedCaratula {
  let titulo: string | null = null;
  let subtotal: number | null = null;
  let utilidad: number | null = null;
  let total: number | null = null;

  for (const row of rows) {
    const a = toStr(row[0]);
    const b = toStr(row[1]);
    const obraMatch = b.match(/^Obra\s*:\s*(.+)$/i);
    if (!titulo && obraMatch) titulo = obraMatch[1].trim();
    if (!titulo && a && /presupuesto/i.test(a)) titulo = a;

    const val = toNum(row[4]) ?? toNum(row[5]);
    if (!b || val == null) continue;
    if (/SUBTOTAL/i.test(b)) subtotal = val;
    else if (/IVA/i.test(b) || /UTILIDAD\s*16\s*%/i.test(b)) {
      // "UTILIDAD 16%" en este template es el IVA — no es utilidad.
    } else if (/UTILIDAD/i.test(b)) utilidad = val;
    else if (/^TOTAL\b/i.test(b.trim())) total = val;
  }
  return { titulo, subtotal, utilidad, total };
}

function parseMaterialesSheet(
  rows: unknown[][],
  warnings: string[]
): ParsedInsumo[] {
  const out: ParsedInsumo[] = [];
  let currentTipo: ParsedInsumo["tipo"] = "MATERIAL";
  let mismatchWarns = 0;

  const base = findBaseCol(rows);
  // Empezar después de la fila de encabezados ("Clave | Descripción | …").
  let start = 0;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    if (toStr((rows[i] ?? [])[base]).toLowerCase() === "clave") {
      start = i + 1;
      break;
    }
  }

  for (let i = start; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const clave = toStr(row[base]);
    const desc = toStr(row[base + 1]);
    if (!clave) continue;

    // Fila de sección: clave = "TIPO", nombre en la columna Cantidad.
    if (/^tipo$/i.test(clave)) {
      const seccion = toStr(row[base + 3])
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "");
      if (seccion.startsWith("herr")) currentTipo = "HERRAMIENTA";
      else if (seccion.startsWith("mano")) currentTipo = "MANO_OBRA";
      else if (seccion.startsWith("equipo") || seccion.startsWith("maquin")) currentTipo = "EQUIPO";
      else if (seccion.startsWith("material")) currentTipo = "MATERIAL";
      else if (seccion.startsWith("contrato") || seccion.startsWith("flete") || seccion.startsWith("subcontr")) currentTipo = "BASICO";
      continue;
    }

    if (/IMPORTE\s+TOTAL/i.test(clave)) continue; // fila de cierre
    if (!desc) continue;

    const unidad = toStr(row[base + 2]) || "pza";
    // "(%)mo": herramienta menor / equipo de seguridad como % de la mano de
    // obra — su "precio" es la base de MO, no un costo unitario requisitable.
    if (/\(%\)/.test(unidad)) continue;

    const cantidad = toNum(row[base + 3]) ?? 0;
    const costo = toNum(row[base + 4]); // PRECIO sin IVA
    if (costo == null) continue;

    // Heurística de desalineación: Gerardo a veces ordena la columna de
    // descripciones sin arrastrar la de claves y quedan corridas una fila.
    // No se puede corregir desde aquí, pero sí avisar.
    const token = clave
      .toUpperCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Z]/g, " ")
      .trim()
      .split(/\s+/)[0];
    const descNorm = desc
      .toUpperCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "");
    if (token && token.length >= 4 && !descNorm.includes(token.slice(0, 4))) {
      if (mismatchWarns < 10) {
        warnings.push(
          `MATERIALES fila ${i + 1}: la clave "${clave}" no parece corresponder a "${desc.slice(0, 40)}" — revisa que las columnas Clave y Descripción no estén corridas en el Excel.`
        );
      }
      mismatchWarns++;
    }

    out.push({
      clave,
      descripcion: desc,
      unidad,
      cantidad,
      costoActual: costo,
      importe: Math.round(cantidad * costo * 100) / 100,
      familia: null,
      tipo: currentTipo,
    });
  }
  if (mismatchWarns > 10) {
    warnings.push(
      `MATERIALES: …y ${mismatchWarns - 10} fila(s) más con clave/descripción que no coinciden.`
    );
  }

  // Dedup por clave: acumular cantidades, avisar si el costo difiere.
  const seen = new Map<string, number>();
  const deduped: ParsedInsumo[] = [];
  for (const ins of out) {
    const idx = seen.get(ins.clave);
    if (idx != null) {
      const prior = deduped[idx];
      if (Math.abs(prior.costoActual - ins.costoActual) > 0.01) {
        warnings.push(
          `Insumo ${ins.clave}: costo distinto en MATERIALES (${prior.costoActual} vs ${ins.costoActual}), se conservó el primero.`
        );
      }
      prior.cantidad += ins.cantidad;
      prior.importe += ins.importe;
      continue;
    }
    seen.set(ins.clave, deduped.length);
    deduped.push({ ...ins });
  }
  return deduped;
}

function parseListaConceptosResult(
  conceptosRows: unknown[][],
  materialesRows: unknown[][],
  caratulaRows: unknown[][],
  warnings: string[]
): PresupuestoParseResult {
  const branches: ParsedPresupuestoBranch[] = [];
  const leaves: ParsedPresupuestoLeaf[] = [];

  // Localizar la fila de encabezados por la celda "Tipo".
  let base = 0;
  let start = 0;
  for (let i = 0; i < Math.min(conceptosRows.length, 15); i++) {
    const row = conceptosRows[i] ?? [];
    for (let c = 0; c < row.length; c++) {
      if (toStr(row[c]).toLowerCase() === "tipo") {
        base = c;
        start = i + 1;
        break;
      }
    }
    if (start) break;
  }
  if (!start) {
    warnings.push(
      'LISTA DE CONCEPTOS: no se encontró la fila de encabezados ("Tipo | Clave | Descripción | …"); se leyó desde el inicio de la hoja.'
    );
  }

  const usedCodes = new Set<string>();
  let localSeq = 0;
  let capSeq = 0;
  let currentLocal: ParsedPresupuestoBranch | null = null;
  let currentCap: ParsedPresupuestoBranch | null = null;
  const conceptoDescs = new Map<string, string>();

  for (let i = start; i < conceptosRows.length; i++) {
    const row = conceptosRows[i] ?? [];
    const tipoCell = toStr(row[base]);
    const claveCell = toStr(row[base + 1]);
    const desc = toStr(row[base + 2]);
    const unidad = toStr(row[base + 3]);
    const cantidad = toNum(row[base + 4]);
    const pu = toNum(row[base + 5]);
    const total = toNum(row[base + 6]);

    // Rama "CAPITULO n" (o "PARTIDA n"). La numeración reinicia por local.
    const capMatch = tipoCell.match(/^(?:CAP[IÍ]TULO|PARTIDA)\s*(\d+)?/i);
    if (capMatch && tipoCell) {
      capSeq++;
      const num = capMatch[1] ? parseInt(capMatch[1], 10) : capSeq;
      let codigo = currentLocal ? `${currentLocal.codigo}.${num}` : String(num);
      if (usedCodes.has(codigo)) {
        codigo = currentLocal ? `${currentLocal.codigo}.${capSeq}` : String(capSeq);
      }
      if (usedCodes.has(codigo)) {
        warnings.push(`Fila ${i + 1}: capítulo con código repetido (${codigo}), se omitió.`);
        continue;
      }
      usedCodes.add(codigo);
      currentCap = {
        kind: "branch",
        codigo,
        nivel: currentLocal ? 2 : 1,
        descripcion: desc || tipoCell,
        importeReportado: total ?? 0,
        rowIndex: i,
      };
      branches.push(currentCap);
      continue;
    }

    // Hoja (leaf): fila "CONCEPTO" o cualquier fila con cantidad y PU.
    const isConceptoRow = /^CONCEPTO/i.test(tipoCell);
    if (isConceptoRow || (cantidad != null && pu != null && desc)) {
      if (cantidad == null || pu == null) {
        warnings.push(
          `Fila ${i + 1}: concepto sin ${cantidad == null ? "cantidad" : "precio unitario"} ("${desc.slice(0, 40)}"), se omitió.`
        );
        continue;
      }
      const parent = currentCap ?? currentLocal;
      if (!parent) {
        warnings.push(`Fila ${i + 1}: concepto sin capítulo padre, se omitió.`);
        continue;
      }
      const clave = claveCell || claveFromDescripcion(desc || `FILA-${i}`);
      const importe = total ?? cantidad * pu;
      const expected = cantidad * pu;
      if (Math.abs(importe - expected) > Math.max(0.05, expected * 0.001)) {
        warnings.push(
          `Fila ${i + 1}: importe ${importe.toFixed(2)} ≠ cantidad × PU ${expected.toFixed(2)}.`
        );
      }
      const prior = conceptoDescs.get(clave);
      if (!prior) conceptoDescs.set(clave, desc);
      leaves.push({
        kind: "leaf",
        parentCodigo: parent.codigo,
        conceptoClave: clave,
        descripcion: prior ?? desc,
        unidad,
        cantidad,
        precioUnitario: pu,
        importe,
        rowIndex: i,
      });
      continue;
    }

    // Agrupador "LOCAL D" (nivel 1): sin tipo ni clave, con descripción y
    // Total pero sin cantidad/PU. La fila "TOTAL …" del gran total se ignora.
    if (!tipoCell && !claveCell && desc && total != null && cantidad == null && pu == null) {
      if (/^TOTAL\b/i.test(desc.trim())) continue;
      localSeq++;
      capSeq = 0;
      currentLocal = {
        kind: "branch",
        codigo: String(localSeq),
        nivel: 1,
        descripcion: desc,
        importeReportado: total,
        rowIndex: i,
      };
      usedCodes.add(currentLocal.codigo);
      branches.push(currentLocal);
      currentCap = null;
      continue;
    }

    // Fila incompleta con pinta de concepto (tiene PU o cantidad pero no
    // ambos): avisar en vez de tirarla en silencio.
    if (desc && (cantidad != null || pu != null)) {
      warnings.push(
        `Fila ${i + 1}: fila con ${cantidad != null ? "cantidad" : "precio"} pero sin ${cantidad != null ? "precio unitario" : "cantidad"} ("${desc.slice(0, 40)}"), se omitió.`
      );
    }
    // Todo lo demás (notas sueltas al final, filas vacías) se ignora.
  }

  const caratula = parseCaratulaLocalesSheet(caratulaRows);
  const insumos = parseMaterialesSheet(materialesRows, warnings);

  const sumLeafImporte = leaves.reduce((a, l) => a + l.importe, 0);
  const sumBranchTopImporte = branches
    .filter((b) => b.nivel === 1)
    .reduce((a, b) => a + b.importeReportado, 0);
  const maxDepth = branches.reduce((m, b) => Math.max(m, b.nivel), 0);

  if (leaves.length === 0) {
    warnings.push(
      'LISTA DE CONCEPTOS: no se encontró ninguna fila "CONCEPTO" — ¿es el formato correcto?'
    );
  }
  if (caratula.subtotal != null) {
    const drift = Math.abs(caratula.subtotal - sumLeafImporte);
    if (drift > Math.max(1, sumLeafImporte * 0.001)) {
      warnings.push(
        `Subtotal CARÁTULA ($${caratula.subtotal.toFixed(2)}) difiere de la suma de conceptos ($${sumLeafImporte.toFixed(2)}) por $${drift.toFixed(2)}.`
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
