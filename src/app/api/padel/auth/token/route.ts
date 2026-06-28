/**
 * POST /api/padel/auth/token
 *
 * Bearer-token login for a padel club MEMBER (B2C). Parallel to the staff flow
 * (/api/auth/token) but issues a member-audience token (theclubpadel:member,
 * see src/lib/api-token.ts) and is scoped to a single club. Member emails are
 * unique per club, so the satellite passes its companyId alongside credentials.
 *
 * Request:  { companyId, email, password }
 * Response 200: { token, member: { id, email, nombre }, club: { id } }
 * Errors: 400 invalid body, 401 bad credentials, 403 module not contracted.
 */

import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { signClubMemberToken } from "@/lib/api-token";
import { withAuthz } from "@/lib/authz";
import { requireClubModule } from "@/lib/club-authz";

const loginSchema = z.object({
  companyId: z.string().min(1),
  email: z.string().email().transform((s) => s.toLowerCase().trim()),
  password: z.string().min(1),
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Credenciales inválidas" }, { status: 400 });
  }
  const { companyId, email, password } = parsed.data;

  await requireClubModule(companyId);

  const member = await prisma.clubMember.findUnique({
    where: { companyId_email: { companyId, email } },
    select: {
      id: true,
      email: true,
      nombre: true,
      passwordHash: true,
      activo: true,
      companyId: true,
    },
  });

  // Uniform messaging to avoid leaking which field was wrong.
  if (!member || !member.activo) {
    return NextResponse.json(
      { error: "Correo o contraseña incorrectos" },
      { status: 401 }
    );
  }
  const ok = await bcrypt.compare(password, member.passwordHash);
  if (!ok) {
    return NextResponse.json(
      { error: "Correo o contraseña incorrectos" },
      { status: 401 }
    );
  }

  const token = await signClubMemberToken({
    sub: member.id,
    email: member.email,
    name: member.nombre,
    companyId: member.companyId,
  });

  return NextResponse.json({
    token,
    member: { id: member.id, email: member.email, nombre: member.nombre },
    club: { id: member.companyId },
  });
});
