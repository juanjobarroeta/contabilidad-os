import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { registrarBitacora } from "@/lib/audit";
import { AuthzError, requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { postPagoCompraPurificadora } from "@/lib/accounting/postings";

type Params = { params: Promise<{ id: string }> };

const compraInclude = {
  supplier: { select: { id: true, razonSocial: true, rfc: true } },
  invoice: { select: { id: true, uuid: true, folio: true, serie: true, total: true } },
  items: { include: { insumo: { select: { id: true, nombre: true, unidad: true } } } },
} as const;

// GET /api/purificadora/compras/[id]
export const GET = withAuthz(async (req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const compra = await prisma.purifCompra.findUnique({ where: { id }, include: compraInclude });
  if (!compra) throw new AuthzError(404, "Compra no encontrada");

  await requireMembership(compra.companyId, undefined, req);
  await requireModule(compra.companyId, "PURIFICADORA", req);

  return NextResponse.json(compra);
});

const patchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("pagar"),
    formaPago: z.enum(["EFECTIVO", "TRANSFERENCIA", "TARJETA"]),
    fecha: z.string().datetime().optional(),
  }),
  z.object({ action: z.literal("vincular-factura"), invoiceId: z.string().min(1) }),
]);

// PATCH /api/purificadora/compras/[id]
//   { action: "pagar", formaPago }            ← liquida una compra a crédito
//   { action: "vincular-factura", invoiceId } ← liga el CFDI recibido
export const PATCH = withAuthz(async (req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const compra = await prisma.purifCompra.findUnique({
    where: { id },
    include: { supplier: { select: { razonSocial: true } } },
  });
  if (!compra) throw new AuthzError(404, "Compra no encontrada");

  const { user: actor } = await requireWriter(compra.companyId, req);
  await requireModule(compra.companyId, "PURIFICADORA", req);

  switch (parsed.data.action) {
    case "pagar": {
      if (compra.estado !== "PENDIENTE") {
        return NextResponse.json(
          { error: `Sólo se pagan compras PENDIENTES (estado actual: ${compra.estado})` },
          { status: 422 }
        );
      }
      const formaPago = parsed.data.formaPago;
      const fecha = parsed.data.fecha ? new Date(parsed.data.fecha) : new Date();

      const updated = await prisma.$transaction(async (tx) => {
        await postPagoCompraPurificadora(tx, {
          companyId: compra.companyId,
          compraId: compra.id,
          descripcion:
            `Pago compra ${compra.folio}` +
            (compra.supplier ? ` — ${compra.supplier.razonSocial}` : ""),
          monto: compra.total,
          formaPago,
          fecha,
        });
        return tx.purifCompra.update({
          where: { id: compra.id },
          data: { estado: "PAGADA", fechaPago: fecha, pagoFormaPago: formaPago },
          include: compraInclude,
        });
      });
      registrarBitacora({
        companyId: compra.companyId,
        userId: actor.id,
        actorEmail: actor.email,
        accion: "compra.pagar",
        entidad: "PurifCompra",
        entidadId: compra.id,
        detalle: { folio: compra.folio, total: compra.total, formaPago },
      });
      return NextResponse.json(updated);
    }

    case "vincular-factura": {
      const invoice = await prisma.invoice.findUnique({
        where: { id: parsed.data.invoiceId },
        select: { id: true, companyId: true },
      });
      if (!invoice || invoice.companyId !== compra.companyId) {
        return NextResponse.json({ error: "Factura inválida" }, { status: 400 });
      }
      const updated = await prisma.purifCompra.update({
        where: { id: compra.id },
        data: { invoiceId: invoice.id },
        include: compraInclude,
      });
      return NextResponse.json(updated);
    }
  }
});
