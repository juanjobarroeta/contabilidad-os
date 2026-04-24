/**
 * POST /api/construccion/presupuestos/[id]/crear-ejecutado
 *
 * Clones an APROBADO contrato presupuesto into a new EJECUTADO presupuesto.
 * The ejecutado starts as an exact copy but can diverge freely as the
 * engineer discovers reality on site.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const contrato = await prisma.presupuesto.findUnique({
      where: { id },
      include: {
        partidas: {
          select: {
            id: true, conceptoId: true, apuVersion: true, cantidad: true,
            precioUnitario: true, importe: true, orden: true, zona: true, partida: true,
            // Tree fields — preserved so ejecutado mirrors contrato capítulo structure
            parentPartidaId: true, nivel: true, codigo: true, esRollup: true,
            unidadProyectoId: true,
          },
          orderBy: { orden: "asc" },
        },
      },
    });
    if (!contrato) throw new AuthzError(404, "Presupuesto no encontrado");
    if (contrato.tipoPresupuesto !== "CONTRATO" || contrato.estado !== "APROBADO") {
      return NextResponse.json(
        { error: "Solo se puede crear un ejecutado desde un presupuesto contrato APROBADO" },
        { status: 422 }
      );
    }

    await requireWriter(contrato.companyId, req);
    await requireModule(contrato.companyId, "CONSTRUCCION");

    // Check if ejecutado already exists
    const existing = await prisma.presupuesto.findFirst({
      where: { proyectoId: contrato.proyectoId, tipoPresupuesto: "EJECUTADO" },
    });
    if (existing) {
      return NextResponse.json(
        { error: "Ya existe un presupuesto ejecutado para este proyecto", ejecutadoId: existing.id },
        { status: 409 }
      );
    }

    const maxVersion = await prisma.presupuesto.aggregate({
      where: { proyectoId: contrato.proyectoId },
      _max: { version: true },
    });

    const ejecutado = await prisma.$transaction(async (tx) => {
      // Step 1: create the ejecutado presupuesto with flat partidas (no parent
      // links yet — they'd point at contrato IDs). Record old→new ID map.
      const created = await tx.presupuesto.create({
        data: {
          companyId: contrato.companyId,
          proyectoId: contrato.proyectoId,
          nombre: "Presupuesto Ejecutado",
          version: (maxVersion._max.version ?? 0) + 1,
          estado: "EN_EJECUCION",
          montoTotal: contrato.montoTotal,
          tipoPresupuesto: "EJECUTADO",
          contratoOrigenId: contrato.id,
        },
      });

      // Build map of contrato partida id → new ejecutado partida id
      const idMap = new Map<string, string>();
      for (const p of contrato.partidas) {
        const newLeaf = await tx.presupuestoPartida.create({
          data: {
            presupuestoId: created.id,
            conceptoId: p.conceptoId,
            apuVersion: p.apuVersion,
            cantidad: p.cantidad,
            precioUnitario: p.precioUnitario,
            importe: p.importe,
            orden: p.orden,
            zona: p.zona,
            partida: p.partida,
            nivel: p.nivel,
            codigo: p.codigo,
            esRollup: p.esRollup,
            unidadProyectoId: p.unidadProyectoId,
            // Link back to the contrato partida for avance tracking
            contratoPartidaId: p.id,
          },
          select: { id: true },
        });
        idMap.set(p.id, newLeaf.id);
      }

      // Step 2: rewire parentPartidaId to point at the cloned ancestors
      for (const p of contrato.partidas) {
        if (!p.parentPartidaId) continue;
        const newParentId = idMap.get(p.parentPartidaId);
        if (!newParentId) continue;
        await tx.presupuestoPartida.update({
          where: { id: idMap.get(p.id)! },
          data: { parentPartidaId: newParentId },
        });
      }

      await tx.presupuestoVersion.create({
        data: {
          presupuestoId: created.id,
          version: 1,
          descripcion: "Copia inicial del contrato aprobado",
          snapshotTotal: created.montoTotal,
        },
      });

      return created;
    });

    return NextResponse.json(ejecutado, { status: 201 });
  }
);
