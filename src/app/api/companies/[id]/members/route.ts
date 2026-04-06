import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireOwner } from "@/lib/authz";
import type { MemberRole } from "@prisma/client";

type Params = { params: Promise<{ id: string }> };

// GET /api/companies/[id]/members
export async function GET(_req: Request, { params }: Params) {
  try {
    const { id: companyId } = await params;
    await requireMembership(companyId);

    const members = await prisma.companyMember.findMany({
      where: { companyId },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    return NextResponse.json(
      members.map((m) => ({
        id: m.id,
        role: m.role,
        createdAt: m.createdAt,
        user: m.user,
      }))
    );
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

const addMemberSchema = z.object({
  // Either invite by email (creates user if missing) or pass userId directly
  email: z.string().email().transform((s) => s.toLowerCase().trim()),
  name: z.string().trim().min(1).max(120).optional(),
  // Temporary password if creating a new user. If omitted, a random one is generated
  // and returned in the response so the inviter can share it manually.
  tempPassword: z.string().min(8).max(200).optional(),
  role: z.enum(["OWNER", "ADMIN", "ACCOUNTANT", "VIEWER"] as const),
});

function randomPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 12; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// POST /api/companies/[id]/members — invite a user to this company
export async function POST(req: Request, { params }: Params) {
  try {
    const { id: companyId } = await params;
    await requireOwner(companyId);

    const body = await req.json().catch(() => null);
    const parsed = addMemberSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Datos inválidos" },
        { status: 400 }
      );
    }

    const { email, name, role } = parsed.data;
    let tempPassword: string | null = null;

    // Find or create user
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      tempPassword = parsed.data.tempPassword ?? randomPassword();
      const hashed = await bcrypt.hash(tempPassword, 10);
      user = await prisma.user.create({
        data: {
          email,
          name: name ?? email.split("@")[0],
          password: hashed,
          // Invited users don't get a personal trial — they ride on the inviter's subscription
          subscriptionStatus: "ACTIVE",
        },
      });
    }

    // Check if already a member
    const existing = await prisma.companyMember.findUnique({
      where: { userId_companyId: { userId: user.id, companyId } },
    });
    if (existing) {
      return NextResponse.json(
        { error: "Este usuario ya es miembro de la empresa" },
        { status: 409 }
      );
    }

    const membership = await prisma.companyMember.create({
      data: { userId: user.id, companyId, role: role as MemberRole },
    });

    return NextResponse.json(
      {
        id: membership.id,
        role: membership.role,
        user: { id: user.id, name: user.name, email: user.email },
        tempPassword, // null if user already existed
      },
      { status: 201 }
    );
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
