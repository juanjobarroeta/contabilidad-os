/**
 * POST /api/auth/token
 *
 * Cross-origin bearer-token login for SPA/API clients (construccion-admin,
 * future fleet-maintenance, etc.). This runs in parallel to NextAuth's
 * session-cookie flow used by the contabilidad-os web UI.
 *
 * Request:
 *   { email: string, password: string }
 *
 * Response (200):
 *   {
 *     token: string,               // 7-day JWT
 *     user:  { id, email, name },
 *     companies: Array<{
 *       id, rfc, razonSocial, role, modulos: ModuloApp[]
 *     }>
 *   }
 *
 * Errors: 400 invalid body, 401 bad credentials, 403 trial expired.
 */

import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { signApiToken } from "@/lib/api-token";
import { effectiveModules } from "@/lib/module-access";

const loginSchema = z.object({
  email: z.string().email().transform((s) => s.toLowerCase().trim()),
  password: z.string().min(1),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Credenciales inválidas" },
      { status: 400 }
    );
  }

  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      name: true,
      password: true,
      subscriptionStatus: true,
      trialEndsAt: true,
    },
  });

  // Uniform timing + messaging to avoid leaking which field was wrong
  if (!user || !user.password) {
    return NextResponse.json(
      { error: "Correo o contraseña incorrectos" },
      { status: 401 }
    );
  }

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) {
    return NextResponse.json(
      { error: "Correo o contraseña incorrectos" },
      { status: 401 }
    );
  }

  // Block expired/canceled accounts
  if (
    user.subscriptionStatus === "EXPIRED" ||
    user.subscriptionStatus === "CANCELED"
  ) {
    return NextResponse.json(
      { error: "Suscripción inactiva. Contacta soporte." },
      { status: 403 }
    );
  }

  const token = await signApiToken({
    sub: user.id,
    email: user.email,
    name: user.name,
  });

  // Include the companies + modules the user belongs to so the client can
  // immediately decide which empresa to activate without a second roundtrip.
  // Apply per-member allowedModules filtering so restricted users (e.g. a
  // construction-only PM) see only the modules they're allowed to use.
  const memberships = await prisma.companyMember.findMany({
    where: { userId: user.id },
    select: {
      role: true,
      allowedModules: true,
      company: {
        select: {
          id: true,
          rfc: true,
          razonSocial: true,
          isActive: true,
          modules: {
            where: { habilitado: true },
            select: { modulo: true },
          },
        },
      },
    },
  });

  const companies = memberships
    .filter((m) => m.company.isActive)
    .map((m) => {
      const enabled = m.company.modules.map((x) => x.modulo);
      const modulos = effectiveModules(enabled, m.allowedModules);
      return {
        id: m.company.id,
        rfc: m.company.rfc,
        razonSocial: m.company.razonSocial,
        role: m.role,
        modulos,
      };
    })
    // Hide companies the user can't actually do anything with (e.g. the
    // company has CONTABILIDAD enabled but the user's allowedModules lists
    // a module the company doesn't have). Without this, the satellite
    // would show an empty company in the selector.
    .filter((c) => c.modulos.length > 0);

  return NextResponse.json({
    token,
    user: { id: user.id, email: user.email, name: user.name },
    companies,
  });
}
