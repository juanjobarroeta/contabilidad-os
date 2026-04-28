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
  // Two access paths to merge:
  //   1. Direct CompanyMember — applies allowedModules restriction.
  //   2. DespachoMember — full module access on every despacho company
  //      (or only on companyScopes rows if any). This is how a despacho's
  //      accountant gets to client companies they don't directly belong to.
  // We load both, then merge by companyId preferring the direct row when
  // both exist (the direct CompanyMember role is the more specific signal).
  const [memberships, despachoMembers] = await Promise.all([
    prisma.companyMember.findMany({
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
    }),
    prisma.despachoMember.findMany({
      where: { userId: user.id },
      select: {
        role: true,
        companyScopes: { select: { companyId: true } },
        despacho: {
          select: {
            companies: {
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
        },
      },
    }),
  ]);

  type CompanyEntry = {
    id: string;
    rfc: string;
    razonSocial: string;
    role: string;
    modulos: string[];
  };
  const byId = new Map<string, CompanyEntry>();

  // 1. Direct memberships first — they win on conflict because their role
  //    + allowedModules are the most precise scope.
  for (const m of memberships) {
    if (!m.company.isActive) continue;
    const enabled = m.company.modules.map((x) => x.modulo);
    const modulos = effectiveModules(enabled, m.allowedModules);
    if (modulos.length === 0) continue;
    byId.set(m.company.id, {
      id: m.company.id,
      rfc: m.company.rfc,
      razonSocial: m.company.razonSocial,
      role: m.role,
      modulos,
    });
  }

  // 2. Despacho-derived access — only fills in companies not already covered
  //    by a direct membership. Despacho members get full module access.
  for (const dm of despachoMembers) {
    const scopeIds = new Set(dm.companyScopes.map((s) => s.companyId));
    const scoped = scopeIds.size > 0;
    for (const c of dm.despacho.companies) {
      if (!c.isActive) continue;
      if (scoped && !scopeIds.has(c.id)) continue;
      if (byId.has(c.id)) continue; // direct membership wins
      const modulos = c.modules.map((x) => x.modulo);
      if (modulos.length === 0) continue;
      byId.set(c.id, {
        id: c.id,
        rfc: c.rfc,
        razonSocial: c.razonSocial,
        role: dm.role,
        modulos,
      });
    }
  }

  const companies = Array.from(byId.values());

  return NextResponse.json({
    token,
    user: { id: user.id, email: user.email, name: user.name },
    companies,
  });
}
