/**
 * GET   /api/restaurante/config?companyId=...
 * PATCH /api/restaurante/config
 *
 * Per-restaurant configuration (IVA rate for A&B sales, número de mesas).
 * GET returns defaults when the row doesn't exist yet; PATCH upserts.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "RESTAURANTE", req);

  const config = await prisma.restauranteConfig.findUnique({ where: { companyId } });
  return NextResponse.json(config ?? { companyId, ivaRate: 0.16, numMesas: 0 });
});

const patchSchema = z.object({
  companyId: z.string().min(1),
  ivaRate: z.number().min(0).max(1).optional(),
  numMesas: z.number().int().min(0).max(500).optional(),
});

export const PATCH = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, ...data } = parsed.data;

  await requireWriter(companyId, req);
  await requireModule(companyId, "RESTAURANTE", req);

  const config = await prisma.restauranteConfig.upsert({
    where: { companyId },
    create: { companyId, ...data },
    update: data,
  });
  return NextResponse.json(config);
});
