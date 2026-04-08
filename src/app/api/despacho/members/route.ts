import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError } from "@/lib/authz";
import { requireDespachoRole, requireOwnDespacho } from "@/lib/despacho";

// GET /api/despacho/members — list everyone in the current despacho
export async function GET() {
  try {
    await requireOwnDespacho();
    const access = await requireOwnDespacho();
    const members = await prisma.despachoMember.findMany({
      where: { despachoId: access.despachoId },
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
    if (e instanceof AuthzError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}

// POST /api/despacho/members — invite existing or create new user
//
// Two modes based on whether a user with `email` already exists:
//
//   (a) User exists → add as despacho member (or error if already in another
//       despacho, since we enforce one-despacho-per-user at the DB level)
//   (b) User doesn't exist → create User + DespachoMember atomically.
//       A random temp password is generated and returned in the response so
//       the inviting user can share it out-of-band (WhatsApp, etc.). Later we
//       swap this for an email magic link.
const inviteSchema = z.object({
  email: z.string().email().transform((s) => s.toLowerCase().trim()),
  name: z.string().trim().min(1).max(120).optional(),
  role: z.enum(["OWNER", "ADMIN", "ACCOUNTANT"] as const).default("ACCOUNTANT"),
  tempPassword: z.string().min(8).max(200).optional(),
});

function randomPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 12; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export async function POST(req: Request) {
  try {
    const access = await requireDespachoRole(["OWNER", "ADMIN"]);

    const parsed = inviteSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Datos inválidos" },
        { status: 400 }
      );
    }
    const { email, name, role } = parsed.data;
    let tempPassword: string | null = null;

    // Find or create the user
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      tempPassword = parsed.data.tempPassword ?? randomPassword();
      const hashed = await bcrypt.hash(tempPassword, 10);
      user = await prisma.user.create({
        data: {
          email,
          name: name ?? email.split("@")[0],
          password: hashed,
          // Despacho members don't get their own trial — they ride on the
          // despacho OWNER's subscription.
          subscriptionStatus: "ACTIVE",
        },
      });
    }

    // Check if they're already in SOME despacho (unique constraint on userId)
    const existing = await prisma.despachoMember.findFirst({
      where: { userId: user.id },
    });
    if (existing) {
      if (existing.despachoId === access.despachoId) {
        return NextResponse.json(
          { error: "El usuario ya pertenece a este despacho" },
          { status: 409 }
        );
      }
      return NextResponse.json(
        {
          error:
            "El usuario ya pertenece a otro despacho. Debe abandonarlo primero antes de unirse a este.",
        },
        { status: 409 }
      );
    }

    const membership = await prisma.despachoMember.create({
      data: {
        despachoId: access.despachoId,
        userId: user.id,
        role,
      },
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
    if (e instanceof AuthzError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
