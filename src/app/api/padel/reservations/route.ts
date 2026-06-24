/**
 * GET  /api/padel/reservations?companyId=...&from=...&to=...&courtId=...
 *        — list reservations in a window (staff)
 * POST /api/padel/reservations
 *        — staff creates a reservation (front-desk booking or on behalf of a
 *          member / walk-in). Source of truth in-app; Playtomic push happens in
 *          the sync cron.
 *
 * Staff-scoped. Gated by PADEL module.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { assertNoConflict } from "@/lib/padel";

export const GET = withAuthz(async (req: Request) => {
  const sp = new URL(req.url).searchParams;
  const companyId = sp.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "PADEL", req);

  const from = sp.get("from");
  const to = sp.get("to");
  const courtId = sp.get("courtId");

  const reservations = await prisma.reservation.findMany({
    where: {
      companyId,
      courtId: courtId ?? undefined,
      inicio: {
        gte: from ? new Date(from) : undefined,
        lt: to ? new Date(to) : undefined,
      },
    },
    include: {
      court: { select: { id: true, nombre: true } },
      clubMember: { select: { id: true, nombre: true } },
    },
    orderBy: { inicio: "asc" },
  });
  return NextResponse.json(reservations);
});

const createSchema = z
  .object({
    companyId: z.string().min(1),
    courtId: z.string().min(1),
    inicio: z.string().datetime(),
    fin: z.string().datetime(),
    clubMemberId: z.string().optional(),
    clienteNombre: z.string().max(120).optional(),
    precio: z.number().nonnegative().optional(),
    notas: z.string().max(500).optional(),
  })
  .refine((d) => new Date(d.fin) > new Date(d.inicio), {
    message: "fin debe ser posterior a inicio",
  });

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, courtId, clubMemberId, clienteNombre, precio, notas } = parsed.data;
  const inicio = new Date(parsed.data.inicio);
  const fin = new Date(parsed.data.fin);

  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "PADEL", req);

  // Court must belong to this company.
  const court = await prisma.court.findUnique({
    where: { id: courtId },
    select: { companyId: true, activa: true },
  });
  if (!court || court.companyId !== companyId) {
    return NextResponse.json({ error: "Cancha inválida" }, { status: 400 });
  }

  // Member, when provided, must belong to this company too.
  if (clubMemberId) {
    const m = await prisma.clubMember.findUnique({
      where: { id: clubMemberId },
      select: { companyId: true },
    });
    if (!m || m.companyId !== companyId) {
      return NextResponse.json({ error: "Miembro inválido" }, { status: 400 });
    }
  }

  await assertNoConflict(prisma, { companyId, courtId, inicio, fin });

  const reservation = await prisma.reservation.create({
    data: {
      companyId,
      courtId,
      inicio,
      fin,
      estado: "CONFIRMADA",
      canal: "STAFF",
      clubMemberId,
      clienteNombre,
      bookedByUserId: user.id,
      precio: precio ?? 0,
      notas,
    },
    include: { court: { select: { id: true, nombre: true } } },
  });
  return NextResponse.json(reservation, { status: 201 });
});
