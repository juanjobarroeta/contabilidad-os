/**
 * GET /api/padel/me/courts — active courts at the member's club (for booking).
 * Member-scoped (theclubpadel:member token). Read-only, only active courts.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withAuthz } from "@/lib/authz";
import { requireClubMember } from "@/lib/club-authz";

export const GET = withAuthz(async (req: Request) => {
  const member = await requireClubMember(req);
  const courts = await prisma.court.findMany({
    where: { companyId: member.companyId, activa: true },
    select: { id: true, nombre: true, superficie: true, techada: true },
    orderBy: { nombre: "asc" },
  });
  return NextResponse.json(courts);
});
