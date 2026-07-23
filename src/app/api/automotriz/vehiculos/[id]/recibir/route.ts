/**
 * POST /api/automotriz/vehiculos/[id]/recibir
 *
 * EN_TRANSITO → DISPONIBLE. Postea la entrada al inventario
 * (DR 1115 / CR 2104) de forma atómica con la transición de estado; la
 * máquina de estados es la idempotencia (una unidad no se recibe dos veces).
 * Arranca el reloj del plan piso si la unidad trae tasa.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { postVehiculoRecibido } from "@/lib/accounting/postings";

const schema = z.object({
  fecha: z.string().datetime().optional(),
  /** Override del costo capturado al alta (último momento editable). */
  costoCompra: z.number().min(0).optional(),
});

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const fecha = parsed.data.fecha ? new Date(parsed.data.fecha) : new Date();

    const vehiculo = await prisma.vehiculo.findUnique({
      where: { id },
      select: {
        id: true,
        companyId: true,
        vin: true,
        estado: true,
        costoCompra: true,
        planPisoTasaAnual: true,
        planPisoInicio: true,
      },
    });
    if (!vehiculo) throw new AuthzError(404, "Unidad no encontrada");

    await requireWriter(vehiculo.companyId, req);
    await requireModule(vehiculo.companyId, "AUTOMOTRIZ", req);

    if (vehiculo.estado !== "EN_TRANSITO") {
      return NextResponse.json(
        { error: `Sólo se reciben unidades EN_TRANSITO (estado actual: ${vehiculo.estado})` },
        { status: 422 }
      );
    }

    const costo = parsed.data.costoCompra ?? vehiculo.costoCompra;
    if (!(costo > 0)) {
      return NextResponse.json(
        { error: "La unidad necesita costo de compra > 0 para postear el inventario" },
        { status: 422 }
      );
    }

    const updated = await prisma.$transaction(async (tx) => {
      await postVehiculoRecibido(tx, {
        companyId: vehiculo.companyId,
        vehiculoId: vehiculo.id,
        vin: vehiculo.vin,
        costo,
        fecha,
      });
      return tx.vehiculo.update({
        where: { id: vehiculo.id },
        data: {
          estado: "DISPONIBLE",
          costoCompra: costo,
          fechaCompra: fecha,
          ...(vehiculo.planPisoTasaAnual != null && !vehiculo.planPisoInicio
            ? { planPisoInicio: fecha }
            : {}),
        },
      });
    });

    return NextResponse.json(updated);
  }
);
