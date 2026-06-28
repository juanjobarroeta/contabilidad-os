/**
 * PATCH /api/padel/me/reservations/[id] — member cancels their OWN reservation.
 *
 * Member-scoped. Only cancellation is allowed from the member side, and only on
 * a future, unpaid, own reservation. Reschedules go through the club desk.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, withAuthz } from "@/lib/authz";
import { requireClubMember } from "@/lib/club-authz";

const patchSchema = z.object({
  estado: z.literal("CANCELADA"),
});

export const PATCH = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const member = await requireClubMember(req);
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Sólo se permite cancelar (estado=CANCELADA)" },
        { status: 400 }
      );
    }

    const r = await prisma.reservation.findUnique({
      where: { id },
      select: { id: true, clubMemberId: true, pagado: true, inicio: true, estado: true },
    });
    if (!r || r.clubMemberId !== member.id) {
      throw new AuthzError(404, "Reserva no encontrada");
    }
    if (r.pagado) {
      return NextResponse.json(
        { error: "La reserva ya fue cobrada; contacta al club" },
        { status: 422 }
      );
    }
    if (r.inicio.getTime() < Date.now()) {
      return NextResponse.json(
        { error: "No se puede cancelar una reserva pasada" },
        { status: 422 }
      );
    }

    const updated = await prisma.reservation.update({
      where: { id },
      data: { estado: "CANCELADA" },
      include: { court: { select: { id: true, nombre: true } } },
    });
    return NextResponse.json(updated);
  }
);
