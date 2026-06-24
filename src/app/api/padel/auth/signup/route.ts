/**
 * POST /api/padel/auth/signup
 *
 * Self-registration for a padel club MEMBER (B2C). Distinct from staff signup
 * (/api/auth/signup, which creates accounting Users). A member always belongs
 * to exactly one club (companyId) and the club must have the PADEL module.
 *
 * Request:  { companyId, email, password, nombre, telefono? }
 * Response 201: { id, email, nombre }
 * Errors: 400 invalid body, 403 module not contracted, 409 email taken.
 */

import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, withAuthz } from "@/lib/authz";
import { requireClubModule } from "@/lib/club-authz";

const signupSchema = z.object({
  companyId: z.string().min(1),
  email: z.string().email().transform((s) => s.toLowerCase().trim()),
  password: z.string().min(8).max(200),
  nombre: z.string().min(1).max(120),
  telefono: z.string().max(40).optional(),
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });
  }
  const { companyId, email, password, nombre, telefono } = parsed.data;

  await requireClubModule(companyId);

  const existing = await prisma.clubMember.findUnique({
    where: { companyId_email: { companyId, email } },
    select: { id: true },
  });
  if (existing) {
    throw new AuthzError(409, "Ya existe un miembro con ese correo en este club");
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const member = await prisma.clubMember.create({
    data: { companyId, email, passwordHash, nombre, telefono },
    select: { id: true, email: true, nombre: true },
  });

  return NextResponse.json(member, { status: 201 });
});
