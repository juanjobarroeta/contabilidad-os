/**
 * POST /api/automotriz/portal/login — login del cliente de la agencia al
 * portal de sólo-lectura. Mismos límites anti credential-stuffing y
 * respuestas uniformes que el portal de la purificadora.
 */

import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { signAutoPortalToken } from "@/lib/api-token";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

const loginSchema = z.object({
  email: z.string().email().transform((s) => s.toLowerCase().trim()),
  password: z.string().min(1),
});

const WINDOW_MS = 15 * 60 * 1000;
const tooMany = (retry?: number) =>
  NextResponse.json(
    { error: "Demasiados intentos. Intenta de nuevo más tarde." },
    { status: 429, headers: { "Retry-After": String(retry ?? 60) } }
  );

export async function POST(req: Request) {
  const ipLimit = checkRateLimit(`auto-portal:ip:${getClientIp(req)}`, { limit: 10, windowMs: WINDOW_MS });
  if (!ipLimit.ok) return tooMany(ipLimit.retryAfterSeconds);

  const body = await req.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Credenciales inválidas" }, { status: 400 });
  const { email, password } = parsed.data;

  const emailLimit = checkRateLimit(`auto-portal:email:${email}`, { limit: 5, windowMs: WINDOW_MS });
  if (!emailLimit.ok) return tooMany(emailLimit.retryAfterSeconds);

  const cuenta = await prisma.autoPortalAccount.findUnique({
    where: { email },
    include: {
      customer: { select: { razonSocial: true, rfc: true } },
      company: { select: { razonSocial: true, nombreComercial: true } },
    },
  });
  if (!cuenta || !cuenta.activo || !(await bcrypt.compare(password, cuenta.passwordHash))) {
    return NextResponse.json({ error: "Correo o contraseña incorrectos" }, { status: 401 });
  }

  const token = await signAutoPortalToken({
    sub: cuenta.id,
    companyId: cuenta.companyId,
    customerId: cuenta.customerId,
    email: cuenta.email,
  });
  await prisma.autoPortalAccount.update({ where: { id: cuenta.id }, data: { lastLoginAt: new Date() } });

  return NextResponse.json({
    token,
    cliente: cuenta.customer,
    agencia: cuenta.company.nombreComercial ?? cuenta.company.razonSocial,
  });
}
