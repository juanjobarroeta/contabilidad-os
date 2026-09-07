/**
 * POST /api/salameria/pedidos/[id]/pagar
 * body: { importe, metodo, esAnticipo?, referenciaExterna?, entregar?, fecha? }
 *
 * Registra un cobro contra el pedido. Es el otro extremo del money-loop.
 *
 * DOS CAMINOS, Y LA DIFERENCIA NO ES COSMÉTICA:
 *
 *   esAnticipo = true  → DR banco / CR 2103 Anticipos de clientes.
 *     La cubeta de Lotus se cobra en marzo y llega en junio. Ese dinero es
 *     deuda con el cliente hasta que se entrega; llamarle ingreso adelanta
 *     utilidad de un ejercicio a otro.
 *
 *   entregar = true    → DR banco (lo que falte) + DR 2103 (lo ya anticipado)
 *                        / CR 4190 mercancía + CR 4191 envío + CR 2102 IVA.
 *     Aquí nace el ingreso. El anticipo entra por el DEBE porque cancela el
 *     pasivo: el dinero ya había entrado al banco cuando se cobró.
 *
 * IDEMPOTENCIA: `referenciaExterna` es único. El webhook de la pasarela puede
 * reintentar tres veces el mismo cargo — con la referencia, el segundo intento
 * responde 200 con el pago que ya existía en vez de cobrar dos veces.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { postAnticipoSalameria, postVentaSalameria } from "@/lib/accounting/postings";

const schema = z.object({
  importe: z.number().positive(),
  metodo: z.enum(["TARJETA", "TRANSFERENCIA", "EFECTIVO", "OXXO", "CREDITO"]),
  esAnticipo: z.boolean().default(false),
  referenciaExterna: z.string().max(200).nullable().optional(),
  /** Cierra el pedido y reconoce el ingreso. */
  entregar: z.boolean().default(false),
  fecha: z.coerce.date().optional(),
});

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { importe, metodo, esAnticipo, referenciaExterna, entregar } = parsed.data;

    const pedido = await prisma.salPedido.findUnique({
      where: { id },
      include: {
        pagos: true,
        cuenta: { select: { nombre: true, email: true } },
        customer: { select: { razonSocial: true } },
      },
    });
    if (!pedido) throw new AuthzError(404, "Pedido no encontrado");

    await requireWriter(pedido.companyId, req);
    await requireModule(pedido.companyId, "SALAMERIA", req);

    if (pedido.estado === "CARRITO") {
      return NextResponse.json(
        { error: "Es un carrito sin confirmar, no un pedido" },
        { status: 409 }
      );
    }
    if (pedido.estado === "CANCELADO") {
      return NextResponse.json({ error: "El pedido está cancelado" }, { status: 409 });
    }
    if (pedido.entregadoAt) {
      return NextResponse.json(
        { error: "El pedido ya fue entregado y facturado" },
        { status: 409 }
      );
    }

    // Reintento del webhook: si esa referencia ya se cobró, se devuelve lo que
    // hay y no se toca nada. Se revisa ANTES de la transacción para no gastar
    // un asiento en el camino feliz del reintento.
    if (referenciaExterna) {
      const existente = await prisma.salPago.findUnique({
        where: { referenciaExterna },
        select: { id: true, pedidoId: true },
      });
      if (existente) {
        return NextResponse.json(
          { ok: true, duplicado: true, pagoId: existente.id },
          { status: 200 }
        );
      }
    }

    const total = Number(pedido.total);
    const pagadoAntes = Number(pedido.pagado);
    const saldo = Math.round((total - pagadoAntes) * 100) / 100;

    if (importe > saldo + 0.01) {
      return NextResponse.json(
        { error: `El pedido debe $${saldo.toFixed(2)}; el cobro es de $${importe.toFixed(2)}` },
        { status: 400 }
      );
    }
    if (entregar && Math.round((pagadoAntes + importe) * 100) / 100 < total - 0.01) {
      // Entregar con saldo pendiente sería una venta a crédito; para eso el
      // método es CREDITO y el cobro entra completo contra 1103.
      if (metodo !== "CREDITO") {
        return NextResponse.json(
          { error: "No se puede entregar con saldo pendiente: cobra el resto o usa CREDITO" },
          { status: 409 }
        );
      }
    }

    const fecha = parsed.data.fecha ?? new Date();
    const nombre =
      pedido.customer?.razonSocial ?? pedido.cuenta?.nombre ?? pedido.cuenta?.email ?? "Mostrador";

    try {
      const resultado = await prisma.$transaction(async (tx) => {
        const vigente = await tx.salPedido.findUnique({
          where: { id },
          select: { entregadoAt: true, pagado: true, estado: true },
        });
        if (vigente?.entregadoAt) {
          throw new AuthzError(409, "El pedido ya fue entregado y facturado");
        }

        const pago = await tx.salPago.create({
          data: {
            pedidoId: id,
            metodo,
            importe,
            fecha,
            esAnticipo,
            referenciaExterna: referenciaExterna ?? null,
          },
        });

        const pagadoDespues = Math.round((Number(vigente!.pagado) + importe) * 100) / 100;

        if (esAnticipo && !entregar) {
          await postAnticipoSalameria(tx, {
            companyId: pedido.companyId,
            pedidoId: id,
            folio: pedido.folio,
            importe,
            // CREDITO no cobra nada: no puede ser un anticipo.
            formaPago: metodo === "CREDITO" ? "TRANSFERENCIA" : metodo,
            fecha,
          });
        }

        if (entregar) {
          // Lo que ya estaba abonado a 2103 antes de este cobro. Este cobro
          // final NO es anticipo: entra por el banco en el mismo asiento.
          const anticipoAplicado = Math.round(
            pedido.pagos.filter((p) => p.esAnticipo).reduce((a, p) => a + Number(p.importe), 0) *
              100
          ) / 100;

          const mercancia =
            Math.round((Number(pedido.subtotal) - Number(pedido.descuento)) * 100) / 100;

          await postVentaSalameria(tx, {
            companyId: pedido.companyId,
            pedidoId: id,
            descripcion: `Pedido ${pedido.folio} — ${nombre}`,
            mercancia,
            envio: Number(pedido.envio),
            iva: Number(pedido.iva),
            anticipoAplicado,
            formaPago: metodo,
            fecha,
          });
        }

        const actualizado = await tx.salPedido.update({
          where: { id },
          data: {
            pagado: pagadoDespues,
            ...(pagadoDespues >= total - 0.01 && !pedido.pagadoAt
              ? { pagadoAt: fecha }
              : {}),
            ...(entregar
              ? { estado: "ENTREGADO", entregadoAt: fecha }
              : pedido.estado === "PENDIENTE_PAGO" && pagadoDespues >= total - 0.01
                ? { estado: "PAGADO" }
                : {}),
          },
        });

        return { pedido: actualizado, pago };
      });

      return NextResponse.json(resultado, { status: 201 });
    } catch (e) {
      // Carrera contra el webhook: los dos pasaron el chequeo previo y el
      // @@unique atajó al segundo. Es el resultado correcto, no un error.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002" &&
        JSON.stringify(e.meta?.target ?? "").includes("referenciaExterna")
      ) {
        return NextResponse.json({ ok: true, duplicado: true }, { status: 200 });
      }
      throw e;
    }
  }
);
