/**
 * POST /api/construccion/gastos/[id]/aprobar
 *
 * Aprueba un gasto SIN pagarlo: PENDIENTE → APROBADO. El gasto aprobado entra
 * al workflow de cuentas por pagar (admin lo manda a tesorería y tesorería
 * registra el pago). Aplica la misma regla de atribución presupuestal que
 * aprobar-pagar: directo (partida/insumo) o indirecto con categoría.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireModule,
  requireUser,
  requireWriter,
  withAuthz,
} from "@/lib/authz";

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const gasto = await prisma.gasto.findUnique({
      where: { id },
      select: {
        id: true,
        companyId: true,
        estado: true,
        presupuestoPartidaId: true,
        insumoId: true,
        indirecto: true,
        categoriaIndirecto: true,
      },
    });
    if (!gasto) throw new AuthzError(404, "Gasto no encontrado");
    await requireWriter(gasto.companyId, req);
    await requireModule(gasto.companyId, "CONSTRUCCION");

    if (gasto.estado !== "PENDIENTE") {
      return NextResponse.json(
        { error: `Solo se pueden aprobar gastos PENDIENTES (actual: ${gasto.estado})` },
        { status: 422 }
      );
    }

    // Misma regla de atribución que aprobar-pagar.
    const isDirecto = !!(gasto.presupuestoPartidaId || gasto.insumoId);
    const isIndirecto = gasto.indirecto === true;
    if (!isDirecto && !isIndirecto) {
      return NextResponse.json(
        {
          error:
            "No se puede aprobar: el gasto debe vincularse a una partida/insumo o marcarse como indirecto (gasolina, viáticos, etc).",
          code: "GASTO_SIN_ATRIBUCION",
        },
        { status: 422 }
      );
    }
    if (isIndirecto && !gasto.categoriaIndirecto) {
      return NextResponse.json(
        {
          error: "Gasto indirecto requiere una categoría (GASOLINA, VIATICOS, FLETE, etc.).",
          code: "GASTO_INDIRECTO_SIN_CATEGORIA",
        },
        { status: 422 }
      );
    }

    const user = await requireUser(req).catch(() => null);

    const updated = await prisma.gasto.update({
      where: { id },
      data: {
        estado: "APROBADO",
        aprobadoPor: user?.id ?? null,
        aprobadoAt: new Date(),
      },
    });

    return NextResponse.json(updated);
  }
);
