/**
 * POST /api/construccion/presupuestos/[id]/partidas
 *
 * Add a new partida to a presupuesto. The server:
 *   - looks up the concepto and its current APU
 *   - snapshots the APU's precioUnitario onto the new partida row
 *     (so future APU edits don't retroactively change this presupuesto)
 *   - computes importe = cantidad × precioUnitario
 *   - recomputes the presupuesto's montoTotal = sum of all partida importes
 *   - returns the new partida with concepto joined
 *
 * Guard: only allowed when parent presupuesto is in BORRADOR. APROBADO /
 * EN_EJECUCION / CERRADO presupuestos are frozen — changes require a
 * clone first.
 *
 * Body: {
 *   conceptoId: string,
 *   cantidad: number > 0,
 *   zona?: string,
 *   partida?: string,
 *   orden?: number
 * }
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

const createSchema = z
  .object({
    // Leaves: require conceptoId + cantidad. Branches: omit both, set esRollup=true.
    conceptoId: z.string().min(1).optional(),
    cantidad: z.number().positive().optional(),
    zona: z.string().max(80).optional(),
    partida: z.string().max(80).optional(),
    orden: z.number().int().nonnegative().optional(),
    parentPartidaId: z.string().min(1).nullable().optional(),
    esRollup: z.boolean().optional(),
    unidadProyectoId: z.string().min(1).nullable().optional(),
    codigo: z.string().max(40).optional(), // client may supply dotted code; server validates/defaults
    nombre: z.string().max(200).optional(), // for branches, stored as `partida`
  })
  .refine(
    (d) => d.esRollup === true || (d.conceptoId && d.cantidad !== undefined),
    { message: "Hojas requieren conceptoId + cantidad; ramas esRollup=true" }
  );

const round2 = (n: number): number => Math.round(n * 100) / 100;

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const body = await req.json().catch(() => ({}));
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const data = parsed.data;

    const presupuesto = await prisma.presupuesto.findUnique({
      where: { id },
      select: { id: true, companyId: true, estado: true },
    });
    if (!presupuesto) {
      throw new AuthzError(404, "Presupuesto no encontrado");
    }

    await requireWriter(presupuesto.companyId, req);
    await requireModule(presupuesto.companyId, "CONSTRUCCION");

    if (presupuesto.estado !== "BORRADOR" && presupuesto.estado !== "EN_EJECUCION") {
      return NextResponse.json(
        {
          error: `Solo se pueden editar presupuestos en BORRADOR (estado actual: ${presupuesto.estado}). Clónalo primero.`,
        },
        { status: 422 }
      );
    }

    // Resolve parent (if any) — drives nivel + default codigo prefix
    let parentNivel = -1;
    let parentCodigo: string | null = null;
    if (data.parentPartidaId) {
      const parent = await prisma.presupuestoPartida.findUnique({
        where: { id: data.parentPartidaId },
        select: {
          id: true,
          presupuestoId: true,
          nivel: true,
          codigo: true,
          esRollup: true,
        },
      });
      if (!parent || parent.presupuestoId !== id) {
        return NextResponse.json(
          { error: "parentPartidaId inválido" },
          { status: 400 }
        );
      }
      if (!parent.esRollup) {
        return NextResponse.json(
          { error: "El padre debe ser una rama (esRollup=true)" },
          { status: 400 }
        );
      }
      parentNivel = parent.nivel;
      parentCodigo = parent.codigo;
    }
    const nivel = parentNivel + 1;

    // Branch (rollup) path — no concepto, no cantidad/PU
    if (data.esRollup) {
      const tail = await prisma.presupuestoPartida.aggregate({
        where: { presupuestoId: id, parentPartidaId: data.parentPartidaId ?? null },
        _max: { orden: true },
      });
      const orden = data.orden ?? (tail._max.orden ?? -1) + 1;

      // Default codigo: parentCodigo.N (1-based sibling index), or N for roots
      const siblingCount = await prisma.presupuestoPartida.count({
        where: { presupuestoId: id, parentPartidaId: data.parentPartidaId ?? null },
      });
      const codigo =
        data.codigo ??
        (parentCodigo ? `${parentCodigo}.${siblingCount + 1}` : `${siblingCount + 1}`);

      const created = await prisma.presupuestoPartida.create({
        data: {
          presupuestoId: id,
          conceptoId: null,
          apuVersion: 1,
          cantidad: null,
          precioUnitario: 0,
          importe: 0,
          orden,
          zona: data.zona,
          partida: data.partida ?? data.nombre ?? null,
          parentPartidaId: data.parentPartidaId ?? null,
          nivel,
          codigo,
          esRollup: true,
          unidadProyectoId: data.unidadProyectoId ?? null,
        },
      });
      return NextResponse.json({ partida: created }, { status: 201 });
    }

    // Leaf path — existing behavior, with optional parent
    // Cross-company check + pull current PU
    const concepto = await prisma.concepto.findUnique({
      where: { id: data.conceptoId! },
      include: {
        apuActual: {
          select: { id: true, version: true, precioUnitario: true },
        },
      },
    });
    if (!concepto || concepto.companyId !== presupuesto.companyId) {
      return NextResponse.json({ error: "Concepto inválido" }, { status: 400 });
    }

    const precioUnitario = Number(concepto.apuActual?.precioUnitario ?? 0);
    const importe = round2(data.cantidad! * precioUnitario);

    // If orden not supplied, append within same parent
    let orden = data.orden;
    if (orden === undefined) {
      const tail = await prisma.presupuestoPartida.aggregate({
        where: {
          presupuestoId: id,
          parentPartidaId: data.parentPartidaId ?? null,
        },
        _max: { orden: true },
      });
      orden = (tail._max.orden ?? -1) + 1;
    }

    // Compute leaf codigo if parent known
    let leafCodigo: string | null = data.codigo ?? null;
    if (!leafCodigo && parentCodigo) {
      const siblingCount = await prisma.presupuestoPartida.count({
        where: { presupuestoId: id, parentPartidaId: data.parentPartidaId ?? null },
      });
      leafCodigo = `${parentCodigo}.${siblingCount + 1}`;
    }

    // Atomic: insert + recompute montoTotal
    const result = await prisma.$transaction(async (tx) => {
      const created = await tx.presupuestoPartida.create({
        data: {
          presupuestoId: id,
          conceptoId: concepto.id,
          apuVersion: concepto.apuActual?.version ?? 1,
          cantidad: data.cantidad!,
          precioUnitario,
          importe,
          orden,
          zona: data.zona,
          partida: data.partida,
          parentPartidaId: data.parentPartidaId ?? null,
          nivel,
          codigo: leafCodigo,
          esRollup: false,
          unidadProyectoId: data.unidadProyectoId ?? null,
        },
        include: {
          concepto: {
            select: { id: true, codigo: true, descripcion: true, unidad: true },
          },
        },
      });

      const agg = await tx.presupuestoPartida.aggregate({
        where: { presupuestoId: id, esRollup: false },
        _sum: { importe: true },
      });
      const montoTotal = round2(Number(agg._sum.importe ?? 0));

      const updatedPresupuesto = await tx.presupuesto.update({
        where: { id },
        data: { montoTotal },
        select: { id: true, montoTotal: true },
      });

      return { partida: created, presupuesto: updatedPresupuesto };
    });

    return NextResponse.json(result, { status: 201 });
  }
);
