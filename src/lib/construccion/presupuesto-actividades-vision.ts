import Anthropic from "@anthropic-ai/sdk";
import { meteredCreate } from "@/lib/costos/anthropic";
import type { CostCtx } from "@/lib/costos/record";
import type {
  ParsedPresupuestoBranch,
  ParsedPresupuestoLeaf,
  PresupuestoParseResult,
} from "./presupuesto-parser";

// ─────────────────────────────────────────────────────────────────────────────
// Extracción por visión de un "PRESUPUESTO POR ACTIVIDADES" en PDF — el
// formato de licitación de obra pública (INIFED/Opus): partidas jerárquicas
// (A.A, A.B, …) con actividades (A.A.1 …) que sólo traen IMPORTE (sin
// cantidad × PU ni insumos).
//
// Estos PDFs suelen venir RASTERIZADOS (sin capa de texto), así que no hay
// parsing clásico posible. Mismo patrón que vision-statement (estados de
// cuenta): Claude visión → JSON estricto → VALIDACIÓN contra los totales
// impresos (Σ actividades ≈ subtotal sin IVA). La extracción financiera
// nunca se confía a ciegas: si no cuadra, se reporta.
//
// Salida: el MISMO PresupuestoParseResult del parser de Excel, para que
// scan/import/estimaciones funcionen sin cambios. Cada actividad se vuelve
// un concepto con cantidad=1 y PU=importe; la plantilla de estimaciones se
// crea POR ACTIVIDAD (granularidad CONCEPTOS, igual que LISTA_CONCEPTOS).
// ─────────────────────────────────────────────────────────────────────────────

const anthropic = new Anthropic();
const MODEL = "claude-sonnet-4-5";

const SYSTEM_PROMPT = `Eres un experto en presupuestos de obra pública mexicana (formato "Presupuesto por Actividades" de licitaciones, estilo Opus/INIFED). Extrae la estructura completa en JSON, sin explicaciones.

REGLAS:
1. Devuelve SOLO un objeto JSON válido, nada de markdown.
2. Montos como números sin símbolos ni comas (468783.97, no "$468,783.97").
3. Extrae TODAS las partidas y TODAS las actividades, en el orden del documento.
4. Los códigos exactamente como aparecen (p. ej. "A.A", "A.A.1"), sin el punto final.
5. Ignora las filas de importe con letra ("* CUATROCIENTOS ... M.N. *").
6. "importeReportado" de una partida = el monto de su fila "TOTAL ..."; null si no aparece.
7. Si un dato no aparece, usa null. NO inventes ni redondees.

SCHEMA:
{
  "obra": string | null,
  "cliente": string | null,
  "partidas": [
    {
      "codigo": string,            // "A.A"
      "descripcion": string,       // "PROYECTO EJECUTIVO"
      "importeReportado": number | null,
      "actividades": [
        { "codigo": string, "descripcion": string, "importe": number }  // "A.A.1"
      ]
    }
  ],
  "subtotalSinIva": number | null,
  "iva": number | null,
  "totalConIva": number | null
}`;

const USER_PROMPT =
  "Extrae el presupuesto por actividades de este documento siguiendo el schema exacto. Solo JSON.";

type RawActividades = {
  obra: string | null;
  cliente: string | null;
  partidas: {
    codigo: string;
    descripcion: string;
    importeReportado: number | null;
    actividades: { codigo: string; descripcion: string; importe: number }[];
  }[];
  subtotalSinIva: number | null;
  iva: number | null;
  totalConIva: number | null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Extrae un presupuesto por actividades desde un PDF (o imagen) vía visión.
 * Lanza Error con mensaje legible si el modelo no devuelve JSON usable.
 */
export async function extractActividadesFromPdf(
  buf: Buffer,
  mediaType: "application/pdf" | "image/jpeg" | "image/png" | "image/webp",
  costCtx?: CostCtx
): Promise<PresupuestoParseResult> {
  const base64 = buf.toString("base64");
  const docBlock: Anthropic.ContentBlockParam =
    mediaType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
      : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };

  const response = await meteredCreate(
    anthropic,
    { subtipo: "construccion.presupuesto_actividades_vision", ...costCtx },
    {
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: [docBlock, { type: "text", text: USER_PROMPT }] }],
    }
  );

  const text =
    (response.content.find((b) => b.type === "text") as { text?: string } | undefined)?.text ?? "";
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

  let raw: RawActividades;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    throw new Error(
      "No se pudo leer el presupuesto del PDF. Verifica que sea un 'Presupuesto por Actividades' legible."
    );
  }
  if (!Array.isArray(raw.partidas) || raw.partidas.length === 0) {
    throw new Error("El PDF no contiene partidas reconocibles de un presupuesto por actividades.");
  }

  const warnings: string[] = [];

  // ── Normalización de códigos ────────────────────────────────────────────
  // Si TODAS las partidas comparten el mismo primer segmento (el raíz "A."
  // del documento), se recorta: "A.A" → "A", "A.A.1" → "A.1". Así cada
  // partida es su propio capítulo para curvas/calendario/estimaciones.
  const firstSeg = (c: string) => c.split(".").filter(Boolean)[0] ?? c;
  const roots = new Set(raw.partidas.map((p) => firstSeg(p.codigo ?? "")));
  const stripRoot = roots.size === 1 && raw.partidas.every((p) => (p.codigo ?? "").includes("."));
  const norm = (c: string) => {
    const clean = (c ?? "").trim().replace(/\.+$/, "");
    if (!stripRoot) return clean;
    const parts = clean.split(".").filter(Boolean);
    return parts.length > 1 ? parts.slice(1).join(".") : clean;
  };

  const branches: ParsedPresupuestoBranch[] = [];
  const leaves: ParsedPresupuestoLeaf[] = [];
  const usedCodes = new Set<string>();
  let row = 0;

  for (const p of raw.partidas) {
    const codigo = norm(p.codigo ?? "");
    if (!codigo || usedCodes.has(codigo)) {
      warnings.push(`Partida "${p.codigo}" con código vacío o repetido — se omitió.`);
      continue;
    }
    usedCodes.add(codigo);
    const acts = Array.isArray(p.actividades) ? p.actividades : [];
    const sumActs = round2(acts.reduce((s, a) => s + (Number(a.importe) || 0), 0));
    const reportado = p.importeReportado != null ? Number(p.importeReportado) : null;
    if (reportado != null && Math.abs(reportado - sumActs) > Math.max(1, reportado * 0.005)) {
      warnings.push(
        `Partida ${codigo} (${p.descripcion}): TOTAL impreso $${reportado.toFixed(2)} ≠ Σ actividades $${sumActs.toFixed(2)}.`
      );
    }
    branches.push({
      kind: "branch",
      codigo,
      nivel: codigo.split(".").filter(Boolean).length,
      descripcion: (p.descripcion ?? codigo).trim(),
      importeReportado: reportado ?? sumActs,
      rowIndex: row++,
    });
    for (const a of acts) {
      const importe = round2(Number(a.importe) || 0);
      if (!a.descripcion || !(importe > 0)) {
        warnings.push(`Actividad "${a.codigo}" sin descripción o importe — se omitió.`);
        continue;
      }
      leaves.push({
        kind: "leaf",
        parentCodigo: codigo,
        conceptoClave: norm(a.codigo ?? "") || `${codigo}.${row}`,
        descripcion: a.descripcion.trim(),
        // Formato por actividades: sólo hay importe. cantidad=1 × PU=importe
        // mantiene el modelo (cantidad × PU = importe) sin inventar datos.
        unidad: "ACT",
        cantidad: 1,
        precioUnitario: importe,
        importe,
        rowIndex: row++,
      });
    }
  }

  if (leaves.length === 0) {
    throw new Error("No se detectó ninguna actividad con importe en el PDF.");
  }

  // ── Gate de validación: Σ actividades ≈ subtotal sin IVA impreso ────────
  const sumLeafImporte = round2(leaves.reduce((s, l) => s + l.importe, 0));
  const subtotal = raw.subtotalSinIva != null ? Number(raw.subtotalSinIva) : null;
  if (subtotal != null) {
    const drift = Math.abs(subtotal - sumLeafImporte);
    if (drift > Math.max(1, subtotal * 0.001)) {
      warnings.push(
        `Subtotal sin IVA impreso ($${subtotal.toFixed(2)}) difiere de la suma de actividades ($${sumLeafImporte.toFixed(2)}) por $${drift.toFixed(2)} — revisa el preview antes de confirmar.`
      );
    }
  } else {
    warnings.push("El PDF no muestra subtotal sin IVA — no se pudo validar la suma extraída.");
  }

  const maxDepth = branches.reduce((m, b) => Math.max(m, b.nivel), 0);
  return {
    caratula: {
      titulo: raw.obra ?? null,
      subtotal,
      utilidad: null,
      total: raw.totalConIva != null ? Number(raw.totalConIva) : null,
    },
    formato: "ACTIVIDADES_PDF",
    branches,
    leaves,
    insumos: [], // el formato no trae insumos; las requisiciones se capturan libres
    warnings,
    totals: {
      branchCount: branches.length,
      leafCount: leaves.length,
      maxDepth,
      sumLeafImporte,
      sumBranchTopImporte: round2(
        branches.filter((b) => b.nivel === 1).reduce((s, b) => s + b.importeReportado, 0)
      ),
    },
  };
}
