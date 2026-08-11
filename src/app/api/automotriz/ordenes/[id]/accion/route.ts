import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/automotriz/ordenes/[id]/accion — transiciones del workflow:
//   iniciar     (RECIBIDA → EN_PROCESO): asigna técnico si viene en el body.
//   terminar    (EN_PROCESO → LISTA): trabajo terminado, esperando entrega.
//   entregar    (LISTA → ENTREGADA): el cliente recogió la unidad.
//   cancelar    (RECIBIDA/EN_PROCESO → CANCELADA).
//   ligarFactura: liga manualmente el CFDI que amparó la orden cuando el
//                 derivador no la encontró solo (invoiceId de una ServicioVenta).
// ─────────────────────────────────────────────────────────────────────────────

const schema = z.object({
  accion: z.enum(["iniciar", "terminar", "entregar", "cancelar", "ligarFactura"]),
  tecnicoId: z.string().nullable().optional(), // iniciar
  invoiceId: z.string().optional(), // ligarFactura
});

export const POST = withAuthz(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { accion } = parsed.data;

  const orden = await prisma.ordenServicio.findUnique({
    where: { id },
    select: { companyId: true, estado: true, tecnicoId: true, servicioVentaId: true },
  });
  if (!orden) throw new AuthzError(404, "Orden no encontrada");
  await requireWriter(orden.companyId, req);
  await requireModule(orden.companyId, "AUTOMOTRIZ", req);

  if (accion === "iniciar") {
    if (orden.estado !== "RECIBIDA") {
      return NextResponse.json({ error: `Sólo una orden RECIBIDA se inicia (${orden.estado})` }, { status: 422 });
    }
    const tecnicoId = parsed.data.tecnicoId !== undefined ? parsed.data.tecnicoId : orden.tecnicoId;
    if (tecnicoId) {
      const emp = await prisma.employee.findUnique({ where: { id: tecnicoId }, select: { companyId: true } });
      if (!emp || emp.companyId !== orden.companyId) {
        return NextResponse.json({ error: "tecnicoId inválido" }, { status: 400 });
      }
    }
    const updated = await prisma.ordenServicio.update({
      where: { id },
      data: { estado: "EN_PROCESO", enProcesoAt: new Date(), tecnicoId },
    });
    return NextResponse.json(updated);
  }

  if (accion === "terminar") {
    if (orden.estado !== "EN_PROCESO") {
      return NextResponse.json({ error: `Sólo una orden EN_PROCESO se termina (${orden.estado})` }, { status: 422 });
    }
    const updated = await prisma.ordenServicio.update({
      where: { id },
      data: { estado: "LISTA", listaAt: new Date() },
    });
    return NextResponse.json(updated);
  }

  if (accion === "entregar") {
    if (orden.estado !== "LISTA") {
      return NextResponse.json({ error: `Sólo una orden LISTA se entrega (${orden.estado})` }, { status: 422 });
    }
    const updated = await prisma.ordenServicio.update({
      where: { id },
      data: { estado: "ENTREGADA", entregadaAt: new Date() },
    });
    return NextResponse.json(updated);
  }

  if (accion === "ligarFactura") {
    const { invoiceId } = parsed.data;
    if (!invoiceId) return NextResponse.json({ error: "invoiceId requerido" }, { status: 400 });
    if (orden.servicioVentaId) {
      return NextResponse.json({ error: "La orden ya tiene factura ligada" }, { status: 422 });
    }
    const venta = await prisma.servicioVenta.findUnique({
      where: { invoiceId },
      select: { id: true, companyId: true, orden: { select: { id: true } } },
    });
    if (!venta || venta.companyId !== orden.companyId) {
      return NextResponse.json(
        { error: "Ese CFDI no es una venta de servicio derivada de esta empresa" },
        { status: 400 }
      );
    }
    if (venta.orden) {
      return NextResponse.json({ error: "Ese CFDI ya ampara otra orden" }, { status: 422 });
    }
    const updated = await prisma.ordenServicio.update({
      where: { id },
      data: { servicioVentaId: venta.id },
    });
    return NextResponse.json(updated);
  }

  // cancelar
  if (orden.estado !== "RECIBIDA" && orden.estado !== "EN_PROCESO") {
    return NextResponse.json({ error: `Una orden ${orden.estado} no se cancela desde aquí` }, { status: 422 });
  }
  const updated = await prisma.ordenServicio.update({ where: { id }, data: { estado: "CANCELADA" } });
  return NextResponse.json(updated);
});
