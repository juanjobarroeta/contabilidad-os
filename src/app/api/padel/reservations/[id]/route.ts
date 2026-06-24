/**
 * GET   /api/padel/reservations/[id]   — fetch one reservation (staff)
 * PATCH /api/padel/reservations/[id]   — update / cancel (staff writer)
 *
 * Cancellation sets estado=CANCELADA. Reschedule (inicio/fin/courtId) re-checks
 * for slot conflicts. A reservation that has already been charged cannot be
 * mutated here (refunds are a separate flow).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { assertNoConflict } from "@/lib/padel";

async function loadReservation(id: string) {
  const r = await prisma.reservation.findUnique({
    where: { id },
    select: {
      id: true,
      companyId: true,
      courtId: true,
      inicio: true,
      fin: true,
      estado: true,
      pagado: true,
    },
  });
  if (!r) throw new AuthzError(404, "Reserva no encontrada");
  return r;
}

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const r = await loadReservation(id);
    await requireMembership(r.companyId, undefined, req);
    await requireModule(r.companyId, "PADEL", req);

    const full = await prisma.reservation.findUnique({
      where: { id },
      include: {
        court: { select: { id: true, nombre: true } },
        clubMember: { select: { id: true, nombre: true, email: true } },
      },
    });
    return NextResponse.json(full);
  }
);

const patchSchema = z.object({
  estado: z.enum(["CONFIRMADA", "CANCELADA", "COMPLETADA", "NO_SHOW"]).optional(),
  inicio: z.string().datetime().optional(),
  fin: z.string().datetime().optional(),
  courtId: z.string().optional(),
  precio: z.number().nonnegative().optional(),
  notas: z.string().max(500).optional(),
});

export const PATCH = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const r = await loadReservation(id);
    await requireWriter(r.companyId, req);
    await requireModule(r.companyId, "PADEL", req);

    if (r.pagado) {
      return NextResponse.json(
        { error: "La reserva ya fue cobrada y no puede modificarse" },
        { status: 422 }
      );
    }

    const inicio = parsed.data.inicio ? new Date(parsed.data.inicio) : r.inicio;
    const fin = parsed.data.fin ? new Date(parsed.data.fin) : r.fin;
    const courtId = parsed.data.courtId ?? r.courtId;

    if (fin <= inicio) {
      return NextResponse.json({ error: "fin debe ser posterior a inicio" }, { status: 400 });
    }

    // Re-check conflicts only when rescheduling and not cancelling.
    const reschedules =
      parsed.data.inicio || parsed.data.fin || parsed.data.courtId;
    const cancelling = parsed.data.estado === "CANCELADA";
    if (reschedules && !cancelling) {
      if (courtId !== r.courtId) {
        const court = await prisma.court.findUnique({
          where: { id: courtId },
          select: { companyId: true },
        });
        if (!court || court.companyId !== r.companyId) {
          return NextResponse.json({ error: "Cancha inválida" }, { status: 400 });
        }
      }
      await assertNoConflict(prisma, {
        companyId: r.companyId,
        courtId,
        inicio,
        fin,
        excludeId: id,
      });
    }

    const updated = await prisma.reservation.update({
      where: { id },
      data: {
        estado: parsed.data.estado,
        inicio: parsed.data.inicio ? inicio : undefined,
        fin: parsed.data.fin ? fin : undefined,
        courtId: parsed.data.courtId ? courtId : undefined,
        precio: parsed.data.precio,
        notas: parsed.data.notas,
      },
      include: { court: { select: { id: true, nombre: true } } },
    });
    return NextResponse.json(updated);
  }
);
