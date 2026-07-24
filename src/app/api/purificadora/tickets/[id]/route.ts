import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cancelar") }),
  z.object({ action: z.literal("reactivar") }),
]);

// PATCH /api/purificadora/tickets/[id]
//   { action: "cancelar" }  ← sólo tickets REGISTRADOS (cobro capturado por
//     error en ventanilla). Un ticket INTEGRADO se corrige cancelando la
//     venta del corte en la página Ventas.
//   { action: "reactivar" } ← revierte una cancelación hecha por error.
//     Sólo OWNER/ADMIN, y sólo si el corte de ese día NO está confirmado
//     (si ya se confirmó, el ticket ya no puede viajar por el corte —
//     captura la venta directamente). Sin efecto contable en ambos casos:
//     los tickets sólo postean al integrarse al corte.
export const PATCH = withAuthz(async (req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const ticket = await prisma.purifTicket.findUnique({
    where: { id },
    select: { id: true, companyId: true, estado: true, fecha: true, total: true },
  });
  if (!ticket) throw new AuthzError(404, "Ticket no encontrado");

  await requireModule(ticket.companyId, "PURIFICADORA", req);

  switch (parsed.data.action) {
    case "cancelar": {
      const { user: actor } = await requireWriter(ticket.companyId, req);
      if (ticket.estado !== "REGISTRADO") {
        return NextResponse.json(
          { error: `Sólo se cancelan tickets REGISTRADOS (estado actual: ${ticket.estado})` },
          { status: 422 }
        );
      }
      const updated = await prisma.purifTicket.update({
        where: { id },
        data: { estado: "CANCELADO" },
      });
      registrarBitacora({
        companyId: ticket.companyId,
        userId: actor.id,
        actorEmail: actor.email,
        accion: "ticket.cancelar",
        entidad: "PurifTicket",
        entidadId: ticket.id,
        detalle: { total: ticket.total, fecha: ticket.fecha.toISOString().slice(0, 10) },
      });
      return NextResponse.json(updated);
    }

    case "reactivar": {
      const { user: actor } = await requireMembership(ticket.companyId, ["OWNER", "ADMIN"], req);
      if (ticket.estado !== "CANCELADO") {
        return NextResponse.json(
          { error: `Sólo se reactivan tickets CANCELADOS (estado actual: ${ticket.estado})` },
          { status: 422 }
        );
      }
      const corte = await prisma.purifCorte.findUnique({
        where: { companyId_fecha: { companyId: ticket.companyId, fecha: ticket.fecha } },
        select: { estado: true },
      });
      if (corte?.estado === "CONFIRMADO") {
        return NextResponse.json(
          {
            error:
              "El corte de ese día ya está confirmado — el ticket ya no puede integrarse. Captura la venta directamente en Ventas.",
          },
          { status: 422 }
        );
      }
      const updated = await prisma.purifTicket.update({
        where: { id },
        data: { estado: "REGISTRADO" },
      });
      registrarBitacora({
        companyId: ticket.companyId,
        userId: actor.id,
        actorEmail: actor.email,
        accion: "ticket.reactivar",
        entidad: "PurifTicket",
        entidadId: ticket.id,
        detalle: { total: ticket.total, fecha: ticket.fecha.toISOString().slice(0, 10) },
      });
      return NextResponse.json(updated);
    }
  }
});
