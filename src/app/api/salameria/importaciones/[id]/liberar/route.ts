/**
 * POST /api/salameria/importaciones/[id]/liberar
 *
 * El momento en que el contenedor se vuelve inventario. Es el «proof flow» del
 * módulo (§4.3 de la guía de satélites): todo ocurre dentro de UNA transacción
 * o no ocurre nada.
 *
 *   1. Prorratea los costos del pedimento sobre las partidas (costeo.ts).
 *   2. Congela el costo unitario en cada `SalImportacionItem` — para poder
 *      auditar el prorrateo años después, cuando ya haya más costos capturados.
 *   3. Crea un `SalLote` por partida con ese costo y su caducidad.
 *   4. Escribe el kardex (ENTRADA_IMPORTACION) y recalcula el espejo.
 *   5. Postea DR 1108 Almacén + DR 1118 IVA acreditable / CR 2104 Acreedores.
 *
 * IDEMPOTENCIA: el estado LIBERADA es lo que impide liberar dos veces. Un
 * segundo POST responde 409 sin tocar nada — sin eso, un doble clic duplicaría
 * el inventario y el asiento.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { prorratearImportacion } from "@/lib/salameria/costeo";
import { entrarLote } from "@/lib/salameria/inventario";
import { postImportacionLiberada } from "@/lib/accounting/postings";

const schema = z.object({
  /** Fecha del asiento y de la entrada al almacén. Default: hoy. */
  fecha: z.coerce.date().optional(),
});

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const parsed = schema.safeParse((await req.json().catch(() => null)) ?? {});
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const imp = await prisma.salImportacion.findUnique({
      where: { id },
      include: {
        supplier: { select: { razonSocial: true } },
        items: { include: { producto: { select: { id: true, pesoKg: true } } } },
        costos: true,
      },
    });
    if (!imp) throw new AuthzError(404, "Importación no encontrada");

    await requireWriter(imp.companyId, req);
    await requireModule(imp.companyId, "SALAMERIA", req);

    if (imp.estado === "LIBERADA") {
      return NextResponse.json(
        { error: "Esta importación ya fue liberada" },
        { status: 409 }
      );
    }
    if (imp.estado === "CANCELADA") {
      return NextResponse.json(
        { error: "Una importación cancelada no se libera" },
        { status: 409 }
      );
    }
    if (imp.items.length === 0) {
      return NextResponse.json(
        { error: "La importación no tiene partidas" },
        { status: 400 }
      );
    }

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

    if (!(costeo.costoMercancia > 0)) {
      return NextResponse.json(
        { error: "El costo de la mercancía es cero: revisa precios y tipo de cambio" },
        { status: 400 }
      );
    }

    const fecha = parsed.data.fecha ?? new Date();
    const porItem = new Map(costeo.items.map((i) => [i.id, i]));

    const resultado = await prisma.$transaction(async (tx) => {
      // Re-lee el estado DENTRO de la transacción: entre el chequeo de arriba y
      // aquí pudo entrar otra liberación (doble clic, dos pestañas). Sin esto
      // las dos pasan el filtro y el inventario se duplica.
      const vigente = await tx.salImportacion.findUnique({
        where: { id },
        select: { estado: true },
      });
      if (vigente?.estado === "LIBERADA") {
        throw new AuthzError(409, "Esta importación ya fue liberada");
      }

      const lotes = [];
      for (const item of imp.items) {
        const c = porItem.get(item.id);
        if (!c) continue;

        await tx.salImportacionItem.update({
          where: { id: item.id },
          data: { costoUnitario: c.costoUnitario },
        });

        const lote = await entrarLote(tx, {
          companyId: imp.companyId,
          productoId: item.productoId,
          cantidad: Number(item.cantidad),
          costoUnitario: c.costoUnitario,
          codigo: item.loteCodigo,
          caducidad: item.caducidad,
          importacionId: imp.id,
          tipo: "ENTRADA_IMPORTACION",
          referencia: imp.id,
          referenciaTipo: "SAL_IMPORTACION",
          fecha,
        });
        lotes.push(lote);
      }

      await postImportacionLiberada(tx, {
        companyId: imp.companyId,
        importacionId: imp.id,
        folio: imp.folio,
        costoMercancia: costeo.costoMercancia,
        ivaImportacion: costeo.ivaImportacion,
        fecha,
        proveedorNombre: imp.supplier?.razonSocial,
        pedimento: imp.pedimento,
      });

      const actualizada = await tx.salImportacion.update({
        where: { id },
        data: { estado: "LIBERADA", liberadaAt: fecha },
      });

      return { importacion: actualizada, lotes: lotes.length };
    });

    return NextResponse.json({
      ...resultado,
      costeo: {
        valorMercancia: costeo.valorMercancia,
        costosProrrateados: costeo.costosProrrateados,
        costoMercancia: costeo.costoMercancia,
        ivaImportacion: costeo.ivaImportacion,
      },
      // El aviso viaja con la respuesta en vez de bloquear: la mercancía ya
      // está en el patio y no liberarla por un peso faltante es peor.
      avisos: [
        ...(costeo.sinPeso.length
          ? [
              `${costeo.sinPeso.length} partida(s) sin peso capturado: el flete por peso se repartió entre las demás`,
            ]
          : []),
        ...(costeo.noAplicados > 0
          ? [
              `$${costeo.noAplicados.toLocaleString("es-MX")} en costos marcados como no prorrateables quedaron fuera del costo`,
            ]
          : []),
      ],
    });
  }
);
