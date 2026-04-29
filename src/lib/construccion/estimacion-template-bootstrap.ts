/**
 * Auto-creates the EstimacionTemplate + curvas for a project right after
 * the master Presupuesto tree lands. Called from /presupuesto/import.
 *
 * Default compaction policy (Decolsa convention):
 *   • Capítulos 1–15 (estructural + impermeabilización + early stuff)
 *     → ROLLED at nivel 1: one row per capítulo, presupuestoPartidaId
 *       points to the depth-1 branch.
 *   • Capítulos ≥16 (acabados, instalaciones, complementos)
 *     → OPEN at nivel 2: one row per direct child branch, so Gerardo can
 *       track albañilería/acabados granularly.
 *
 * Curvas (weekly distribution per top capítulo):
 *   Pre-loaded from CURVA_VIVIENDA_2R_DEFAULT, padded/truncated to the
 *   project's weekCount. Capítulos without a default (e.g. project-specific
 *   trabajos extras) get an empty curve and a TODO marker.
 *
 * Idempotent: refuses to run if a template already exists for this proyecto.
 * Re-bootstrap = delete the template first (which cascades to its partidas).
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  CURVA_DEFAULT_WEEK_COUNT,
  CURVA_VIVIENDA_2R_DEFAULT,
} from "./curva-vivienda-default";

type Tx = Prisma.TransactionClient | PrismaClient;

const ROLLUP_THRESHOLD = 15; // capítulos ≤ this stay rolled at nivel 1

export type BootstrapResult = {
  templateId: string;
  partidasCreated: number;
  curvasCreated: number;
  calendarioCreated: number;
};

/**
 * Bootstrap the EstimacionTemplate for a freshly-imported presupuesto.
 *
 * Args:
 *   tx — prisma transaction client (we run inside the import's transaction)
 *   proyectoId
 *   companyId
 *   presupuestoId — the just-created Presupuesto we're cloning from
 *   weekCount — defaults to 48; can be overridden if the project span differs
 */
export async function bootstrapEstimacionTemplate(
  tx: Tx,
  args: {
    proyectoId: string;
    companyId: string;
    presupuestoId: string;
    weekCount?: number;
  }
): Promise<BootstrapResult> {
  const { proyectoId, companyId, presupuestoId } = args;
  const weekCount = args.weekCount ?? CURVA_DEFAULT_WEEK_COUNT;

  // Pull all branches in one query so we can pick which to expose.
  // We compute depth FROM the codigo (not the stored nivel) because past
  // imports occasionally landed everything at nivel=1; codigo is the SOT.
  const branches = await tx.presupuestoPartida.findMany({
    where: { presupuestoId, esRollup: true },
    select: {
      id: true,
      codigo: true,
      nivel: true,
      partida: true,
      parentPartidaId: true,
      orden: true,
    },
    orderBy: [{ orden: "asc" }],
  });

  // Compute true depth from the codigo. "1" → 1, "1.0" → 1 (cosmetic),
  // "1.1" → 2, "1.1.3" → 3. Strip trailing ".0+" before counting.
  const depthOf = (codigo: string | null): number => {
    if (!codigo) return 0;
    const normalized = codigo.replace(/\.0+$/, "");
    return normalized.split(".").filter(Boolean).length;
  };
  const topCapitulo = (codigo: string | null): string | null => {
    if (!codigo) return null;
    const normalized = codigo.replace(/\.0+$/, "");
    const head = normalized.split(".")[0];
    return head || null;
  };

  type B = (typeof branches)[number];
  const depth1: B[] = [];
  const depth2ByParentCap: Map<string, B[]> = new Map();
  for (const b of branches) {
    const d = depthOf(b.codigo);
    if (d === 1) depth1.push(b);
    else if (d === 2) {
      const cap = topCapitulo(b.codigo);
      if (cap) {
        if (!depth2ByParentCap.has(cap)) depth2ByParentCap.set(cap, []);
        depth2ByParentCap.get(cap)!.push(b);
      }
    }
  }

  // Build the partida list according to the rule.
  type Pick = {
    presupuestoPartidaId: string;
    capituloCode: string; // "1", "2", ... (top-level for curve lookup)
    descripcion: string;
    orden: number;
  };
  const picks: Pick[] = [];
  let orden = 0;

  // Sort depth1 by numeric capítulo so we get rows 1, 2, 3, ..., 30.
  depth1.sort((a, b) => {
    const ca = parseInt(topCapitulo(a.codigo) ?? "0", 10);
    const cb = parseInt(topCapitulo(b.codigo) ?? "0", 10);
    return ca - cb;
  });

  // Dedupe by topCapitulo: some past imports stored both "12" and "12.0" as
  // separate depth-1 branches. Pick the one whose codigo is the canonical
  // form (just digits, no trailing ".0+") if present, else the first.
  const dedupedDepth1: B[] = [];
  const seenCap = new Set<string>();
  // Prefer canonical-format rows first
  const preferred = depth1.filter((b) => /^\d+$/.test(b.codigo ?? ""));
  const fallback = depth1.filter((b) => !/^\d+$/.test(b.codigo ?? ""));
  for (const b of [...preferred, ...fallback]) {
    const cap = topCapitulo(b.codigo);
    if (!cap || seenCap.has(cap)) continue;
    seenCap.add(cap);
    dedupedDepth1.push(b);
  }
  // Sort the deduped list back into capítulo order
  dedupedDepth1.sort((a, b) => {
    const ca = parseInt(topCapitulo(a.codigo) ?? "0", 10);
    const cb = parseInt(topCapitulo(b.codigo) ?? "0", 10);
    return ca - cb;
  });

  for (const cap of dedupedDepth1) {
    const capCode = topCapitulo(cap.codigo);
    if (!capCode) continue;
    const capNum = parseInt(capCode, 10);
    if (Number.isNaN(capNum)) continue;

    if (capNum <= ROLLUP_THRESHOLD) {
      // Roll up: one row for the whole capítulo
      picks.push({
        presupuestoPartidaId: cap.id,
        capituloCode: capCode,
        descripcion: cap.partida ?? `Capítulo ${capCode}`,
        orden: orden++,
      });
    } else {
      // Open: one row per direct child (depth-2 branches under this cap).
      // If the capítulo has no depth-2 children (just leaves directly under
      // it), fall back to rolling up.
      const children = depth2ByParentCap.get(capCode) ?? [];
      if (children.length === 0) {
        picks.push({
          presupuestoPartidaId: cap.id,
          capituloCode: capCode,
          descripcion: cap.partida ?? `Capítulo ${capCode}`,
          orden: orden++,
        });
      } else {
        for (const child of children) {
          picks.push({
            presupuestoPartidaId: child.id,
            capituloCode: capCode, // curve lookup at top level
            descripcion: child.partida ?? `${capCode} ${child.codigo}`,
            orden: orden++,
          });
        }
      }
    }
  }

  // Create the EstimacionTemplate root + partidas
  const template = await tx.estimacionTemplate.create({
    data: {
      proyectoId,
      companyId,
    },
    select: { id: true },
  });

  // Batch insert partidas (createMany is ~10x faster than a sequential loop)
  if (picks.length > 0) {
    await tx.estimacionTemplatePartida.createMany({
      data: picks.map((p) => ({
        templateId: template.id,
        presupuestoPartidaId: p.presupuestoPartidaId,
        capituloCode: p.capituloCode,
        descripcion: p.descripcion,
        orden: p.orden,
      })),
    });
  }

  // Pre-load curvas. Match against capítulo codes that actually appear in
  // the picks list — no curva for capítulos absent from the project.
  const usedCapitulos = new Set(picks.map((p) => p.capituloCode));
  type CurvaRow = {
    templateId: string;
    capituloCode: string;
    descripcion: string;
    pesoPctSemanal: number[];
  };
  const curvaRows: CurvaRow[] = [];
  for (const def of CURVA_VIVIENDA_2R_DEFAULT) {
    if (!usedCapitulos.has(def.capituloCode)) continue;
    curvaRows.push({
      templateId: template.id,
      capituloCode: def.capituloCode,
      descripcion: def.descripcion,
      pesoPctSemanal: padWeeks(def.pesoPctSemanal, weekCount),
    });
  }
  // Capítulos in the project that DON'T have a default curve: create an
  // empty curve so the UI can render a placeholder (Gerardo edits it).
  for (const cap of usedCapitulos) {
    if (CURVA_VIVIENDA_2R_DEFAULT.some((c) => c.capituloCode === cap)) continue;
    const desc =
      picks.find((p) => p.capituloCode === cap)?.descripcion ?? `Capítulo ${cap}`;
    curvaRows.push({
      templateId: template.id,
      capituloCode: cap,
      descripcion: desc,
      pesoPctSemanal: new Array(weekCount).fill(0),
    });
  }

  if (curvaRows.length > 0) {
    await tx.estimacionCurvaCapitulo.createMany({ data: curvaRows });
  }

  // Calendario Cierre — Gerardo's internal cashflow planner. We seed empty
  // rows (one per capítulo, all-zero weekly distribution) so the editor has
  // a row to render. Gerardo fills cells by hand to project his outflow.
  const calRows = [...usedCapitulos].map((cap) => ({
    templateId: template.id,
    capituloCode: cap,
    descripcion:
      picks.find((p) => p.capituloCode === cap)?.descripcion ?? `Capítulo ${cap}`,
    pesoPctSemanal: new Array(weekCount).fill(0),
  }));
  if (calRows.length > 0) {
    await tx.calendarioCierreCapitulo.createMany({ data: calRows });
  }

  return {
    templateId: template.id,
    partidasCreated: picks.length,
    curvasCreated: curvaRows.length,
    calendarioCreated: calRows.length,
  };
}

function padWeeks(arr: number[], target: number): number[] {
  if (arr.length === target) return arr;
  if (arr.length > target) return arr.slice(0, target);
  return [...arr, ...new Array(target - arr.length).fill(0)];
}
