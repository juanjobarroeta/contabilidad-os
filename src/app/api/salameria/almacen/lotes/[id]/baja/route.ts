/**
 * POST /api/salameria/almacen/lotes/[id]/baja
 * body: { cantidad, tipo: "SALIDA_MERMA" | "SALIDA_CADUCIDAD", nota? }
 *
 * Da de baja mercancía que se perdió. Descuenta el lote, escribe el kardex y
 * postea DR 5121 Mermas y caducidades / CR 1108 Almacén.
 *
 * POR QUÉ POSTEA. Dejar la merma sólo en el inventario hace que el almacén del
 * balance quede más alto que la mercancía que existe, y el día del conteo
 * físico aparece un descuadre sin explicación. Reconocerla cuando ocurre es lo
 * que hace que el estado de resultados enseñe el costo real de comprar de más.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireWriter, requireModule, withAuthz } from "@/lib/authz";
import { bajaDeLote, StockInsuficiente } from "@/lib/salameria/inventario";
import { postMermaSalameria } from "@/lib/accounting/postings";

const schema = z.object({
  cantidad: z.number().positive(),
  tipo: z.enum(["SALIDA_MERMA", "SALIDA_CADUCIDAD"]),
  nota: z.string().max(300).nullable().optional(),
  fecha: z.coerce.date().optional(),
});

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const lote = await prisma.salLote.findUnique({
      where: { id },
      select: {
        id: true,
        companyId: true,
        producto: { select: { sku: true, nombre: true } },
      },
    });
    if (!lote) throw new AuthzError(404, "Lote no encontrado");

    await requireWriter(lote.companyId, req);
    await requireModule(lote.companyId, "SALAMERIA", req);

    const fecha = parsed.data.fecha ?? new Date();

    try {
      const resultado = await prisma.$transaction(async (tx) => {
        const baja = await bajaDeLote(tx, {
          companyId: lote.companyId,
          loteId: id,
          cantidad: parsed.data.cantidad,
          tipo: parsed.data.tipo,
          nota: parsed.data.nota,
          fecha,
        });

        // Costo cero (un lote de muestra sin costo) no genera asiento: postear
        // un importe de 0 rompe el balanceo y ensucia el mayor con renglones
        // que no dicen nada.
        if (baja.costo > 0) {
          const etiqueta =
            parsed.data.tipo === "SALIDA_CADUCIDAD" ? "Caducidad" : "Merma";
          await postMermaSalameria(tx, {
            companyId: lote.companyId,
            movimientoId: baja.movimientoId,
            descripcion: `${etiqueta} — ${lote.producto.sku} ${lote.producto.nombre}`,
            costo: baja.costo,
            fecha,
          });
        }

        return baja;
      });

      return NextResponse.json(resultado, { status: 201 });
    } catch (e) {
      if (e instanceof StockInsuficiente) {
        return NextResponse.json({ error: e.message }, { status: 409 });
      }
      throw e;
    }
  }
);
