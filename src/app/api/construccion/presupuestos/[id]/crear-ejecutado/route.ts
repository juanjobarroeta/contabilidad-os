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
          },
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
          partidas: {
            create: contrato.partidas.map((p) => ({
              conceptoId: p.conceptoId,
              apuVersion: p.apuVersion,
              cantidad: p.cantidad,
              precioUnitario: p.precioUnitario,
              importe: p.importe,
              orden: p.orden,
              zona: p.zona,
              partida: p.partida,
              // Link back to the contrato partida for avance tracking
              contratoPartidaId: p.id,
            })),
          },
        },
      });

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
