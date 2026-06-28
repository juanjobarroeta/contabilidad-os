/**
 * GET  /api/padel/courts?companyId=...   — list courts (staff)
 * POST /api/padel/courts                 — create a court (staff writer)
 *
 * Staff-scoped (accounting User + CompanyMember). Gated by PADEL module.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";

export const GET = withAuthz(async (req: Request) => {
  const companyId = new URL(req.url).searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "PADEL", req);

  const courts = await prisma.court.findMany({
    where: { companyId },
    orderBy: { nombre: "asc" },
  });
  return NextResponse.json(courts);
});

const createSchema = z.object({
  companyId: z.string().min(1),
  nombre: z.string().min(1).max(80),
  superficie: z.string().max(80).optional(),
  techada: z.boolean().optional(),
  activa: z.boolean().optional(),
  playtomicResourceId: z.string().max(120).optional(),
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, ...data } = parsed.data;

  await requireWriter(companyId, req);
  await requireModule(companyId, "PADEL", req);

  const court = await prisma.court.create({ data: { companyId, ...data } });
  return NextResponse.json(court, { status: 201 });
});
