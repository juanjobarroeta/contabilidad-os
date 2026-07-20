import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import {
  postCancelacionVentaPurificadora,
  postCobroVentaPurificadora,
} from "@/lib/accounting/postings";

type Params = { params: Promise<{ id: string }> };

// GET /api/purificadora/ventas/[id]
export const GET = withAuthz(async (req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const venta = await prisma.purifVenta.findUnique({
    where: { id },
    include: {
      items: true,
      customer: { select: { id: true, razonSocial: true, rfc: true, phone: true } },
      invoice: { select: { id: true, uuid: true, folio: true, status: true, total: true } },
      bankTransaction: { select: { id: true, fecha: true, monto: true, descripcion: true } },
    },
  });
  if (!venta) throw new AuthzError(404, "Venta no encontrada");

  await requireMembership(venta.companyId, undefined, req);
  await requireModule(venta.companyId, "PURIFICADORA", req);

  return NextResponse.json(venta);
});

const patchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("cobrar"),
    formaPago: z.enum(["EFECTIVO", "TRANSFERENCIA", "TARJETA"]),
    fecha: z.string().datetime().optional(),
  }),
  z.object({ action: z.literal("cancelar") }),
  z.object({ action: z.literal("vincular-factura"), invoiceId: z.string().min(1) }),
]);

// PATCH /api/purificadora/ventas/[id]
//   { action: "cobrar", formaPago }        ← liquida una venta a crédito
//   { action: "cancelar" }                 ← cancela y revierte el asiento
//   { action: "vincular-factura", invoiceId } ← liga el CFDI que la ampara
export const PATCH = withAuthz(async (req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const venta = await prisma.purifVenta.findUnique({
    where: { id },
    include: { customer: { select: { razonSocial: true } } },
  });
  if (!venta) throw new AuthzError(404, "Venta no encontrada");

  await requireWriter(venta.companyId, req);
  await requireModule(venta.companyId, "PURIFICADORA", req);

  switch (parsed.data.action) {
    case "cobrar": {
      if (venta.estado !== "PENDIENTE") {
        return NextResponse.json(
          { error: `Sólo se cobran ventas PENDIENTES (estado actual: ${venta.estado})` },
          { status: 422 }
        );
      }
      const formaPago = parsed.data.formaPago;
      const fecha = parsed.data.fecha ? new Date(parsed.data.fecha) : new Date();

      const updated = await prisma.$transaction(async (tx) => {
        await postCobroVentaPurificadora(tx, {
          companyId: venta.companyId,
          ventaId: venta.id,
          descripcion:
            `Cobro venta ${venta.folio}` +
            (venta.customer ? ` — ${venta.customer.razonSocial}` : ""),
          monto: venta.total,
          formaPago,
          fecha,
        });
        return tx.purifVenta.update({
          where: { id: venta.id },
          data: { estado: "COBRADA", fechaCobro: fecha, cobroFormaPago: formaPago },
        });
      });
      return NextResponse.json(updated);
    }

    case "cancelar": {
      if (venta.estado === "CANCELADA") {
        return NextResponse.json({ error: "La venta ya está cancelada" }, { status: 422 });
      }
      if (venta.invoiceId) {
        return NextResponse.json(
          { error: "La venta tiene CFDI vinculado; cancela primero la factura" },
          { status: 422 }
        );
      }
      if (venta.bankTransactionId) {
        return NextResponse.json(
          { error: "La venta está conciliada con un movimiento bancario; desconcíliala primero" },
          { status: 422 }
        );
      }

      const cobro =
        venta.formaPago === "CREDITO" && venta.estado === "COBRADA" && venta.cobroFormaPago
          ? {
              monto: venta.total,
              formaPago: venta.cobroFormaPago as "EFECTIVO" | "TRANSFERENCIA" | "TARJETA",
            }
          : null;

      const updated = await prisma.$transaction(async (tx) => {
        await postCancelacionVentaPurificadora(tx, {
          companyId: venta.companyId,
          ventaId: venta.id,
          descripcion:
            `Cancelación venta ${venta.folio}` +
            (venta.customer ? ` — ${venta.customer.razonSocial}` : ""),
          subtotal: venta.subtotal,
          iva: venta.iva,
          formaPago: venta.formaPago,
          cobro,
          fecha: new Date(),
        });
        return tx.purifVenta.update({
          where: { id: venta.id },
          data: { estado: "CANCELADA" },
        });
      });
      return NextResponse.json(updated);
    }

    case "vincular-factura": {
      const invoice = await prisma.invoice.findUnique({
        where: { id: parsed.data.invoiceId },
        select: { id: true, companyId: true },
      });
      if (!invoice || invoice.companyId !== venta.companyId) {
        return NextResponse.json({ error: "Factura inválida" }, { status: 400 });
      }
      const updated = await prisma.purifVenta.update({
        where: { id: venta.id },
        data: { invoiceId: invoice.id },
      });
      return NextResponse.json(updated);
    }
  }
});
