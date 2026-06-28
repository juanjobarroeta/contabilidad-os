/**
 * GET /api/padel/me — the authenticated club member's own profile.
 * Member-scoped (theclubpadel:member token).
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withAuthz } from "@/lib/authz";
import { requireClubMember } from "@/lib/club-authz";

export const GET = withAuthz(async (req: Request) => {
  const member = await requireClubMember(req);
  const full = await prisma.clubMember.findUnique({
    where: { id: member.id },
    select: {
      id: true,
      email: true,
      nombre: true,
      telefono: true,
      companyId: true,
      createdAt: true,
    },
  });
  return NextResponse.json(full);
});
