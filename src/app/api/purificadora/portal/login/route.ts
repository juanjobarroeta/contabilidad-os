import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { signPurifPortalToken } from "@/lib/api-token";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

const loginSchema = z.object({
  email: z.string().email().transform((s) => s.toLowerCase().trim()),
  password: z.string().min(1),
});

const WINDOW_MS = 15 * 60 * 1000;

// POST /api/purificadora/portal/login — login del cliente-empresa al portal.
// Mismos límites anti credential-stuffing que /api/auth/token; respuestas
// uniformes para no filtrar si el correo existe.
export async function POST(req: Request) {
  const ipLimit = checkRateLimit(`portal:ip:${getClientIp(req)}`, {
    limit: 10,
    windowMs: WINDOW_MS,
  });
  if (!ipLimit.ok) {
    return NextResponse.json(
      { error: "Demasiados intentos. Intenta de nuevo más tarde." },
      { status: 429, headers: { "Retry-After": String(ipLimit.retryAfterSeconds ?? 60) } }
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Credenciales inválidas" }, { status: 400 });
  }
  const { email, password } = parsed.data;

  const emailLimit = checkRateLimit(`portal:email:${email}`, { limit: 5, windowMs: WINDOW_MS });
  if (!emailLimit.ok) {
    return NextResponse.json(
      { error: "Demasiados intentos. Intenta de nuevo más tarde." },
      { status: 429, headers: { "Retry-After": String(emailLimit.retryAfterSeconds ?? 60) } }
    );
  }

  const cuenta = await prisma.purifPortalAccount.findUnique({
    where: { email },
    include: {
      customer: { select: { razonSocial: true, rfc: true } },
      company: {
        select: { razonSocial: true, purifConfig: { select: { nombreComercial: true } } },
      },
    },
  });

  const ok = cuenta?.activo && (await bcrypt.compare(password, cuenta.passwordHash));
  if (!cuenta || !ok) {
    return NextResponse.json({ error: "Correo o contraseña incorrectos" }, { status: 401 });
  }

  const token = await signPurifPortalToken({
    sub: cuenta.id,
    companyId: cuenta.companyId,
    customerId: cuenta.customerId,
    email: cuenta.email,
  });

  await prisma.purifPortalAccount.update({
    where: { id: cuenta.id },
    data: { lastLoginAt: new Date() },
  });

  return NextResponse.json({
    token,
    cliente: { razonSocial: cuenta.customer.razonSocial, rfc: cuenta.customer.rfc },
    negocio: cuenta.company.purifConfig?.nombreComercial ?? cuenta.company.razonSocial,
  });
}
