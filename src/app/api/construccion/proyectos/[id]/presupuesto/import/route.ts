/**
 * POST /api/construccion/proyectos/[id]/presupuesto/import
 *
 * Atomic write of the parsed presupuesto tree from /scan. Three steps:
 *
 *   1. Upsert Conceptos by (companyId, codigo). New concepto rows created
 *      from leaf claves; existing rows are reused (no description overwrite,
 *      so Gerardo's manually-curated copy is preserved).
 *   2. Optionally upsert Insumos from the INSUMOS sheet (idempotent on
 *      (companyId, codigo)). First-time imports populate the catalog.
 *   3. Create the Presupuesto + the full PresupuestoPartida tree:
 *        - One branch row per parsed branch, parentPartidaId chained,
 *          esRollup=true, conceptoId=null
 *        - One leaf row per parsed leaf, conceptoId set, importe = Q×PU
 *        - Branch importes recomputed server-side (Σ children) so we
 *          don't trust Excel rollups
 *      All in a single $transaction so partial writes can't happen.
 *
 * Body: { parsed: PresupuestoParseResult, filename?: string }
 *
 * Response: { presupuestoId, leafCount, branchCount, conceptosCreated,
 *             insumosCreated, total }
 *
 * Reimport policy: if the proyecto already has any Presupuesto, reject
 * with 409. Per the agreed plan, reimport flows are deferred — Gerardo
 * can archive the old proyecto + create a v2 if needed.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireModule,
  requireWriter,
  withAuthz,
} from "@/lib/authz";
import type {
  ParsedPresupuestoBranch,
  ParsedPresupuestoLeaf,
  ParsedInsumo,
  PresupuestoParseResult,
} from "@/lib/construccion/presupuesto-parser";
import { bootstrapEstimacionTemplate } from "@/lib/construccion/estimacion-template-bootstrap";
import { CURVA_DEFAULT_WEEK_COUNT } from "@/lib/construccion/curva-vivienda-default";

// We trust the structure but validate the shape so a malformed payload can't
// hose the import. Numbers must be finite, strings non-empty, etc.
const branchSchema = z.object({
  kind: z.literal("branch"),
  codigo: z.string().min(1),
  nivel: z.number().int().min(1),
  descripcion: z.string(),
  importeReportado: z.number().finite(),
  rowIndex: z.number().int().nonnegative(),
});

const leafSchema = z.object({
  kind: z.literal("leaf"),
  parentCodigo: z.string().min(1).nullable(),
  conceptoClave: z.string().min(1),
  descripcion: z.string(),
  unidad: z.string(),
  cantidad: z.number().finite(),
  precioUnitario: z.number().finite(),
  importe: z.number().finite(),
  rowIndex: z.number().int().nonnegative(),
});

const insumoSchema = z.object({
  clave: z.string().min(1),
  descripcion: z.string(),
  unidad: z.string(),
  cantidad: z.number().finite().default(0),
  costoActual: z.number().finite(),
  importe: z.number().finite().default(0),
  familia: z.string().nullable(),
  tipo: z.enum(["MATERIAL", "MANO_OBRA", "EQUIPO", "HERRAMIENTA", "BASICO"]),
});

const bodySchema = z.object({
  parsed: z.object({
    caratula: z.object({
      titulo: z.string().nullable(),
      subtotal: z.number().nullable(),
      utilidad: z.number().nullable(),
      total: z.number().nullable(),
    }),
    formato: z.enum(["PRESUPUESTO", "LISTA_CONCEPTOS", "MATRICES"]).optional(),
    branches: z.array(branchSchema),
    leaves: z.array(leafSchema),
    insumos: z.array(insumoSchema),
    warnings: z.array(z.string()),
    totals: z.object({
      branchCount: z.number(),
      leafCount: z.number(),
      maxDepth: z.number(),
      sumLeafImporte: z.number(),
      sumBranchTopImporte: z.number(),
    }),
  }),
  filename: z.string().optional(),
  // Decolsa workflow extras — set during the import wizard. All optional;
  // when missing we fall back to schema defaults / leave fields null.
  viviendasObjetivo: z.number().int().positive().nullable().optional(),
  aplicaIva: z.boolean().optional(),
  weekCount: z.number().int().positive().nullable().optional(),
  fechaInicio: z.string().datetime().nullable().optional(),
  fechaFinPlan: z.string().datetime().nullable().optional(),
  // Confirmation flag — UI sets this when the user has acknowledged the
  // warnings panel. Belt-and-suspenders so a stale tab can't import without
  // the user seeing the preview.
  confirmed: z.literal(true),
});

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const proyecto = await prisma.proyecto.findUnique({
      where: { id },
      select: { id: true, companyId: true, codigo: true },
    });
    if (!proyecto) throw new AuthzError(404, "Proyecto no encontrado");
    await requireWriter(proyecto.companyId, req);
    await requireModule(proyecto.companyId, "CONSTRUCCION");

    const body = await req.json().catch(() => ({}));
    const validated = bodySchema.safeParse(body);
    if (!validated.success) {
      return NextResponse.json(
        { error: "Payload inválido", detail: validated.error.flatten() },
        { status: 400 }
      );
    }
    const {
      parsed,
      filename,
      viviendasObjetivo,
      aplicaIva,
      weekCount,
      fechaInicio,
      fechaFinPlan,
    } = validated.data;

    // Reimport guard
    const existing = await prisma.presupuesto.count({ where: { proyectoId: id } });
    if (existing > 0) {
      return NextResponse.json(
        {
          error:
            "Este proyecto ya tiene un presupuesto cargado. Para sustituirlo, archiva el actual primero.",
        },
        { status: 409 }
      );
    }

    const result = await prisma.$transaction(
      async (tx) => {
        // ─── Step 1: Upsert Conceptos (one per distinct leaf clave) ──────────
        // Description policy: keep existing concepto.descripcion if the
        // concepto row exists; otherwise use the leaf description.
        const distinctClaves = new Map<string, ParsedPresupuestoLeaf>();
        for (const l of parsed.leaves) {
          if (!distinctClaves.has(l.conceptoClave)) distinctClaves.set(l.conceptoClave, l);
        }

        const existingConceptos = await tx.concepto.findMany({
          where: {
            companyId: proyecto.companyId,
            codigo: { in: [...distinctClaves.keys()] },
          },
          select: { id: true, codigo: true },
        });
        const conceptoIdByClave = new Map<string, string>(
          existingConceptos.map((c) => [c.codigo, c.id])
        );

        let conceptosCreated = 0;
        for (const [clave, leaf] of distinctClaves) {
          if (conceptoIdByClave.has(clave)) continue;
          const created = await tx.concepto.create({
            data: {
              companyId: proyecto.companyId,
              codigo: clave,
              descripcion: leaf.descripcion || clave,
              unidad: leaf.unidad || "pza",
            },
            select: { id: true },
          });
          conceptoIdByClave.set(clave, created.id);
          conceptosCreated++;
        }

        // ─── Step 2: Upsert Insumos from INSUMOS sheet + create explosion rows ──
        // Insumo catalog: upsert by (companyId, codigo) — update costoActual
        // so reimports freshen the unit price without clobbering manual edits.
        // PresupuestoInsumo: one row per insumo storing the project-total
        // quantity from the explosion sheet; used as "planeado" baseline in
        // Explosión vs Real when per-concepto APU data is not loaded.
        let insumosCreated = 0;
        const insumoIdByClave = new Map<string, string>();
        if (parsed.insumos.length > 0) {
          for (const ins of parsed.insumos) {
            const row = await tx.insumo.upsert({
              where: { companyId_codigo: { companyId: proyecto.companyId, codigo: ins.clave } },
              create: {
                companyId: proyecto.companyId,
                codigo: ins.clave,
                descripcion: ins.descripcion || ins.clave,
                unidad: ins.unidad,
                tipo: ins.tipo,
                costoActual: ins.costoActual,
              },
              update: { costoActual: ins.costoActual },
              select: { id: true, codigo: true },
            });
            insumoIdByClave.set(ins.clave, row.id);
            insumosCreated++;
          }
        }

        // ─── Step 3: Create Presupuesto + tree ───────────────────────────────
        const presupuesto = await tx.presupuesto.create({
          data: {
            companyId: proyecto.companyId,
            proyectoId: id,
            nombre: parsed.caratula.titulo ?? `Presupuesto ${proyecto.codigo}`,
            tipoPresupuesto: "CONTRATO",
            estado: "BORRADOR",
            // montoTotal computed below from the tree
            montoTotal: 0,
          },
          select: { id: true },
        });

        // First pass: create branches in nivel order so parent rows exist
        // before children. We assign orden = global row order so
        // PresupuestoDetalle can render in source order.
        const branchIdByCodigo = new Map<string, string>();
        const sortedBranches = [...parsed.branches].sort((a, b) => {
          if (a.nivel !== b.nivel) return a.nivel - b.nivel;
          return a.rowIndex - b.rowIndex;
        });
        for (const b of sortedBranches) {
          // Parent = drop the last segment of the dotted code
          const parentCodigo = b.codigo.includes(".")
            ? b.codigo.split(".").slice(0, -1).join(".")
            : null;
          const parentPartidaId = parentCodigo
            ? branchIdByCodigo.get(parentCodigo) ?? null
            : null;

          const created = await tx.presupuestoPartida.create({
            data: {
              presupuestoId: presupuesto.id,
              codigo: b.codigo,
              nivel: b.nivel,
              parentPartidaId,
              esRollup: true,
              conceptoId: null,
              cantidad: null,
              precioUnitario: 0,
              importe: 0, // recomputed below
              orden: b.rowIndex,
              partida: b.descripcion.slice(0, 200), // legacy display field
            },
            select: { id: true },
          });
          branchIdByCodigo.set(b.codigo, created.id);
        }

        // Second pass: leaves
        for (const l of parsed.leaves) {
          const conceptoId = conceptoIdByClave.get(l.conceptoClave);
          if (!conceptoId) {
            throw new Error(
              `Concepto ${l.conceptoClave} no se creó (bug en el upsert).`
            );
          }
          const parentPartidaId = l.parentCodigo
            ? branchIdByCodigo.get(l.parentCodigo) ?? null
            : null;
          if (!parentPartidaId) {
            throw new Error(
              `Leaf ${l.conceptoClave} no encontró su padre ${l.parentCodigo}.`
            );
          }

          await tx.presupuestoPartida.create({
            data: {
              presupuestoId: presupuesto.id,
              codigo: null,
              nivel: 0, // leaves don't get a tree level number
              parentPartidaId,
              esRollup: false,
              conceptoId,
              cantidad: l.cantidad,
              precioUnitario: l.precioUnitario,
              importe: l.importe,
              orden: l.rowIndex,
            },
          });
        }

        // ─── Step 3b: PresupuestoInsumo explosion rows ───────────────────────
        if (insumoIdByClave.size > 0) {
          for (const ins of parsed.insumos) {
            const insumoId = insumoIdByClave.get(ins.clave);
            if (!insumoId) continue;
            await tx.presupuestoInsumo.create({
              data: {
                presupuestoId: presupuesto.id,
                insumoId,
                cantidad: ins.cantidad,
                costoUnitario: ins.costoActual,
                importe: ins.importe,
              },
            });
          }
        }

        // ─── Step 4: Recompute branch importes from children (server SOT) ────
        // Walk branches deepest-first so children's importes are final before
        // their parent rolls them up.
        const allBranches = [...parsed.branches].sort((a, b) => b.nivel - a.nivel);
        const importeByBranchId = new Map<string, number>();
        for (const b of allBranches) {
          const branchId = branchIdByCodigo.get(b.codigo)!;
          // Sum direct children: leaves (importe) + child branches (already computed)
          const children = await tx.presupuestoPartida.findMany({
            where: { parentPartidaId: branchId },
            select: { id: true, importe: true, esRollup: true },
          });
          let total = 0;
          for (const c of children) {
            if (c.esRollup) {
              total += importeByBranchId.get(c.id) ?? c.importe;
            } else {
              total += c.importe;
            }
          }
          importeByBranchId.set(branchId, total);
          await tx.presupuestoPartida.update({
            where: { id: branchId },
            data: { importe: total },
          });
        }

        // Total = Σ depth-1 branches
        const total = parsed.branches
          .filter((b) => b.nivel === 1)
          .reduce((a, b) => a + (importeByBranchId.get(branchIdByCodigo.get(b.codigo)!) ?? 0), 0);

        await tx.presupuesto.update({
          where: { id: presupuesto.id },
          data: { montoTotal: total },
        });

        // ─── Step 5: Stamp the proyecto ──────────────────────────────────────
        // Stamp the proyecto with file metadata + the wizard fields the user
        // supplied (viviendasObjetivo, aplicaIva, weekCount, fechas).
        const finalWeekCount = weekCount ?? CURVA_DEFAULT_WEEK_COUNT;
        await tx.proyecto.update({
          where: { id },
          data: {
            presupuestoSourceFile: filename ?? null,
            presupuestoImportadoAt: new Date(),
            ...(viviendasObjetivo != null ? { viviendasObjetivo } : {}),
            ...(aplicaIva !== undefined ? { aplicaIva } : {}),
            weekCount: finalWeekCount,
            ...(fechaInicio ? { fechaInicio: new Date(fechaInicio) } : {}),
            ...(fechaFinPlan ? { fechaFinPlan: new Date(fechaFinPlan) } : {}),
          },
        });

        // Auto-fill montoContratado if not set (cost × utilidad).
        const proyectoActual = await tx.proyecto.findUnique({
          where: { id },
          select: { montoContratado: true, utilidadPorc: true },
        });
        if (proyectoActual && proyectoActual.montoContratado == null) {
          const factor = 1 + (proyectoActual.utilidadPorc ?? 0) / 100;
          await tx.proyecto.update({
            where: { id },
            data: { montoContratado: total * factor },
          });
        }

        // ─── Step 6: Bootstrap the EstimacionTemplate ────────────────────────
        // Decolsa workflow needs the billing structure ready immediately.
        // Vivienda (formato PRESUPUESTO): compactado por capítulo (1-15
        // rolled / ≥16 open). Remodelaciones (LISTA DE CONCEPTOS): una fila
        // POR CONCEPTO — las estimaciones se capturan a ese nivel, no por
        // capítulo condensado.
        const bootstrap = await bootstrapEstimacionTemplate(tx, {
          proyectoId: id,
          companyId: proyecto.companyId,
          presupuestoId: presupuesto.id,
          weekCount: finalWeekCount,
          granularidad:
            parsed.formato === "LISTA_CONCEPTOS" ? "CONCEPTOS" : "CAPITULOS",
        });

        return {
          presupuestoId: presupuesto.id,
          leafCount: parsed.leaves.length,
          branchCount: parsed.branches.length,
          conceptosCreated,
          insumosCreated,
          presupuestoInsumosCreated: insumoIdByClave.size,
          total,
          templateId: bootstrap.templateId,
          templatePartidasCreated: bootstrap.partidasCreated,
          curvasCreated: bootstrap.curvasCreated,
        };
      },
      // Bigger projects (Decolsa: ~2000 rows) need a longer interactive tx.
      { timeout: 60_000, maxWait: 5_000 }
    );

    return NextResponse.json(result);
  }
);
