/**
 * GET  /api/padel/me/reservations?from=...&to=...  — the member's own bookings
 * POST /api/padel/me/reservations                  — member books a court slot
 *
 * Member-scoped (theclubpadel:member token). A member can only ever see/create
 * their OWN reservations. Self-booked slots are channel APP with precio 0 — the
 * club sets/collects the price at the desk (online payment lands in a later
 * milestone). Slot conflicts are rejected (409).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { withAuthz } from "@/lib/authz";
import { requireClubMember } from "@/lib/club-authz";
import { assertNoConflict } from "@/lib/padel";

export const GET = withAuthz(async (req: Request) => {
  const member = await requireClubMember(req);
  const sp = new URL(req.url).searchParams;
  const from = sp.get("from");
  const to = sp.get("to");

  const reservations = await prisma.reservation.findMany({
    where: {
      companyId: member.companyId,
      clubMemberId: member.id,
      inicio: {
        gte: from ? new Date(from) : undefined,
        lt: to ? new Date(to) : undefined,
      },
    },
    include: { court: { select: { id: true, nombre: true } } },
    orderBy: { inicio: "asc" },
  });
  return NextResponse.json(reservations);
});

const createSchema = z
  .object({
    courtId: z.string().min(1),
    inicio: z.string().datetime(),
    fin: z.string().datetime(),
    notas: z.string().max(500).optional(),
  })
  .refine((d) => new Date(d.fin) > new Date(d.inicio), {
    message: "fin debe ser posterior a inicio",
  });

export const POST = withAuthz(async (req: Request) => {
  const member = await requireClubMember(req);
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { courtId, notas } = parsed.data;
  const inicio = new Date(parsed.data.inicio);
  const fin = new Date(parsed.data.fin);

  // Court must be active and belong to the member's club.
  const court = await prisma.court.findUnique({
    where: { id: courtId },
    select: { companyId: true, activa: true },
  });
  if (!court || court.companyId !== member.companyId || !court.activa) {
    return NextResponse.json({ error: "Cancha inválida" }, { status: 400 });
  }

  // Members can't book in the past.
  if (inicio.getTime() < Date.now()) {
    return NextResponse.json({ error: "No se puede reservar en el pasado" }, { status: 400 });
  }

  await assertNoConflict(prisma, { companyId: member.companyId, courtId, inicio, fin });

  const reservation = await prisma.reservation.create({
    data: {
      companyId: member.companyId,
      courtId,
      inicio,
      fin,
      estado: "CONFIRMADA",
      canal: "APP",
      clubMemberId: member.id,
      precio: 0,
      notas,
    },
    include: { court: { select: { id: true, nombre: true } } },
  });
  return NextResponse.json(reservation, { status: 201 });
});
