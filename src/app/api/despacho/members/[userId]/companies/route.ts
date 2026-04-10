import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ userId: string }> };

// GET /api/despacho/members/[userId]/companies
// Returns the company scope for a despacho member (empty = all companies)
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { userId: targetUserId } = await params;

  const myMember = await prisma.despachoMember.findFirst({
    where: { userId: session.user.id },
    select: { despachoId: true, role: true },
  });
  if (!myMember || (myMember.role !== "OWNER" && myMember.role !== "ADMIN")) {
    return NextResponse.json({ error: "Solo owner/admin pueden ver scoping" }, { status: 403 });
  }

  const targetMember = await prisma.despachoMember.findFirst({
    where: { userId: targetUserId, despachoId: myMember.despachoId },
    select: { id: true },
  });
  if (!targetMember) return NextResponse.json({ error: "Miembro no encontrado" }, { status: 404 });

  const scopes = await prisma.despachoMemberCompany.findMany({
    where: { despachoMemberId: targetMember.id },
    include: {
      company: { select: { id: true, rfc: true, razonSocial: true } },
    },
  });

  return NextResponse.json({
    memberId: targetMember.id,
    scopeType: scopes.length === 0 ? "all" : "restricted",
    companies: scopes.map((s) => s.company),
  });
}

// PUT /api/despacho/members/[userId]/companies
// Sets the company scope for a despacho member.
// Body: { companyIds: string[] } — empty array = access to all companies
export async function PUT(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { userId: targetUserId } = await params;

  const myMember = await prisma.despachoMember.findFirst({
    where: { userId: session.user.id },
    select: { despachoId: true, role: true },
  });
  if (!myMember || (myMember.role !== "OWNER" && myMember.role !== "ADMIN")) {
    return NextResponse.json({ error: "Solo owner/admin pueden gestionar scoping" }, { status: 403 });
  }

  const targetMember = await prisma.despachoMember.findFirst({
    where: { userId: targetUserId, despachoId: myMember.despachoId },
    select: { id: true, role: true },
  });
  if (!targetMember) return NextResponse.json({ error: "Miembro no encontrado" }, { status: 404 });

  // Don't allow scoping OWNER — they always see everything
  if (targetMember.role === "OWNER") {
    return NextResponse.json({ error: "No se puede restringir al owner del despacho" }, { status: 400 });
  }

  const { companyIds } = (await req.json()) as { companyIds: string[] };

  // Validate all company IDs belong to this despacho
  if (companyIds.length > 0) {
    const valid = await prisma.company.count({
      where: { id: { in: companyIds }, despachoId: myMember.despachoId },
    });
    if (valid !== companyIds.length) {
      return NextResponse.json({ error: "Algunas empresas no pertenecen al despacho" }, { status: 400 });
    }
  }

  // Replace all scopes atomically
  await prisma.$transaction([
    prisma.despachoMemberCompany.deleteMany({
      where: { despachoMemberId: targetMember.id },
    }),
    ...companyIds.map((companyId) =>
      prisma.despachoMemberCompany.create({
        data: { despachoMemberId: targetMember.id, companyId },
      })
    ),
  ]);

  return NextResponse.json({
    ok: true,
    scopeType: companyIds.length === 0 ? "all" : "restricted",
    count: companyIds.length,
  });
}
