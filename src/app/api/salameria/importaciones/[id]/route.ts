/**
 * GET   /api/salameria/importaciones/[id]
 * PATCH /api/salameria/importaciones/[id]
 *
 * La ficha del contenedor, con el costeo CALCULADO EN VIVO mientras sigue
 * abierto: cada costo que se captura mueve el costo por caja al instante, y
 * ése es el número con el que se decide el precio de venta antes de que la
 * mercancía llegue. Al liberar, ese cálculo se congela en los lotes.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireMembership,
  requireModule,
  requireWriter,
  withAuthz,
} from "@/lib/authz";
import { prorratearImportacion } from "@/lib/salameria/costeo";

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const imp = await prisma.salImportacion.findUnique({
      where: { id },
      include: {
        supplier: { select: { id: true, razonSocial: true, rfc: true } },
        items: {
          include: {
            producto: {
              select: { id: true, sku: true, nombre: true, unidad: true, pesoKg: true },
            },
          },
        },
        costos: true,
        lotes: { select: { id: true, productoId: true, cantidad: true, costoUnitario: true } },
      },
    });
    if (!imp) throw new AuthzError(404, "Importación no encontrada");

    await requireMembership(imp.companyId, undefined, req);
    await requireModule(imp.companyId, "SALAMERIA", req);

    const costeo = prorratearImportacion({
      items: imp.items.map((i) => ({
        id: i.id,
        cantidad: Number(i.cantidad),
        precioMoneda: Number(i.precioMoneda),
        pesoKg: Number(i.producto.pesoKg),
      })),
      costos: imp.costos.map((c) => ({
        tipo: c.tipo,
        importe: Number(c.importe),
        prorratea: c.prorratea,
        base: c.base,
      })),
      tipoCambio: Number(imp.tipoCambio),
    });

    const porItem = new Map(costeo.items.map((i) => [i.id, i]));

    return NextResponse.json({
      ...imp,
      items: imp.items.map((i) => ({ ...i, costeo: porItem.get(i.id) ?? null })),
      costeo: {
        valorMercancia: costeo.valorMercancia,
        costosProrrateados: costeo.costosProrrateados,
        costoMercancia: costeo.costoMercancia,
        ivaImportacion: costeo.ivaImportacion,
        noAplicados: costeo.noAplicados,
        sinPeso: costeo.sinPeso,
      },
    });
  }
);

const patchSchema = z.object({
  supplierId: z.string().nullable().optional(),
  estado: z.enum(["BORRADOR", "EN_TRANSITO", "EN_ADUANA", "CANCELADA"]).optional(),
  pedimento: z.string().max(30).nullable().optional(),
  aduana: z.string().max(80).nullable().optional(),
  fechaPedimento: z.coerce.date().nullable().optional(),
  fechaLlegada: z.coerce.date().nullable().optional(),
  moneda: z.string().min(3).max(3).optional(),
  tipoCambio: z.number().positive().optional(),
  notas: z.string().max(2000).nullable().optional(),
});

export const PATCH = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const parsed = patchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const imp = await prisma.salImportacion.findUnique({
      where: { id },
      select: { id: true, companyId: true, estado: true },
    });
    if (!imp) throw new AuthzError(404, "Importación no encontrada");

    await requireWriter(imp.companyId, req);
    await requireModule(imp.companyId, "SALAMERIA", req);

    // Una importación LIBERADA ya nació como lotes y como asiento. Cambiarle el
    // tipo de cambio o el pedimento dejaría el costo del inventario distinto
    // del que se posteó, sin nada que lo reconcilie. La corrección de una
    // liberada es un ajuste de inventario, no una edición.
    if (imp.estado === "LIBERADA") {
      return NextResponse.json(
        { error: "Una importación liberada ya no se edita: corrige con un ajuste de inventario" },
        { status: 409 }
      );
    }
    // Liberar tiene su propia ruta (crea lotes y postea); no se llega por PATCH.
    if (parsed.data.estado === undefined && Object.keys(parsed.data).length === 0) {
      return NextResponse.json({ error: "Nada que actualizar" }, { status: 400 });
    }

    const actualizada = await prisma.salImportacion.update({
      where: { id },
      data: parsed.data,
    });

    return NextResponse.json(actualizada);
  }
);
