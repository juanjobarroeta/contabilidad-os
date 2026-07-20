import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({ action: z.literal("cancelar") });

// PATCH /api/purificadora/tickets/[id] — { action: "cancelar" }
// Sólo tickets REGISTRADOS (aún no integrados a un corte): p. ej. un cobro
// capturado por error en ventanilla. Un ticket INTEGRADO se corrige
// cancelando la venta del corte en la página Ventas.
export const PATCH = withAuthz(async (req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const ticket = await prisma.purifTicket.findUnique({
    where: { id },
    select: { id: true, companyId: true, estado: true },
  });
  if (!ticket) throw new AuthzError(404, "Ticket no encontrado");

  await requireWriter(ticket.companyId, req);
  await requireModule(ticket.companyId, "PURIFICADORA", req);

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
  return NextResponse.json(updated);
});
