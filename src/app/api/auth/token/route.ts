/**
 * POST /api/auth/token
 *
 * Cross-origin bearer-token login for SPA/API clients (padel, bartiz,
 * FlotaGob, ZionX, etc.). This runs in parallel to NextAuth's
 * session-cookie flow used by the contabilidad-os web UI.
 *
 * Request:
 *   {
 *     email: string,
 *     password: string,
 *     cliente?: string,   // etiqueta del satélite (fallback: User-Agent)
 *     scope?: string      // scopes separados por espacio, p. ej. "clientes facturas"
 *   }
 *
 * Response (200):
 *   {
 *     token: string,            // access JWT de 1 hora (con jti y scope opcional)
 *     refreshToken: string,     // secreto opaco de 30 días, ROTATORIO
 *     expiresIn: 3600,
 *     refreshExpiresIn: 2592000,
 *     user:  { id, email, name },
 *     companies: Array<{ id, rfc, razonSocial, role, modulos: ModuloApp[] }>
 *   }
 *
 * Los tokens legados de 7 días quedaron RETIRADOS (agosto 2026): ni se
 * emiten ni verifican — verifyApiToken exige jti.
 *
 * Renovación: POST /api/auth/token/refresh. Revocación: /api/me/tokens.
 * Guía para satélites: docs/API-TOKENS.md.
 *
 * Errors: 400 invalid body, 401 bad credentials, 403 trial expired.
 */

import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  ACCESS_TOKEN_EXPIRY_SECONDS,
  signApiToken,
} from "@/lib/api-token";
import {
  emitirRefreshToken,
  REFRESH_TOKEN_EXPIRY_SECONDS,
} from "@/lib/api-refresh-token";
import { registrarBitacora } from "@/lib/audit";
import { effectiveModules } from "@/lib/module-access";
import { isOperador } from "@/lib/authz";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

const loginSchema = z.object({
  email: z.string().email().transform((s) => s.toLowerCase().trim()),
  password: z.string().min(1),
  cliente: z.string().trim().max(120).optional(),
  scope: z
    .string()
    .trim()
    .max(200)
    .regex(/^[a-z0-9_-]+(\s+[a-z0-9_-]+)*$/i, "scope inválido")
    .optional(),
});

const WINDOW_MS = 15 * 60 * 1000;

function tooManyAttempts(retryAfterSeconds?: number) {
  return NextResponse.json(
    { error: "Demasiados intentos. Intenta de nuevo más tarde." },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfterSeconds ?? 60) },
    }
  );
}

export async function POST(req: Request) {
  // Límite por IP contra credential stuffing. La respuesta 429 es uniforme
  // (no revela si el correo existe), igual que el 401 de credenciales.
  const ipLimit = checkRateLimit(`token:ip:${getClientIp(req)}`, {
    limit: 10,
    windowMs: WINDOW_MS,
  });
  if (!ipLimit.ok) {
    return tooManyAttempts(ipLimit.retryAfterSeconds);
  }

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

  const { email, password, cliente, scope } = parsed.data;

  // Límite por correo (normalizado): se aplica exista o no la cuenta, para
  // no filtrar información por diferencia de comportamiento.
  const emailLimit = checkRateLimit(`token:email:${email}`, {
    limit: 5,
    windowMs: WINDOW_MS,
  });
  if (!emailLimit.ok) {
    return tooManyAttempts(emailLimit.retryAfterSeconds);
  }

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

  // Etiqueta del satélite para poder identificar/revocar el token después.
  const etiqueta =
    cliente ||
    req.headers.get("user-agent")?.trim().slice(0, 120) ||
    "satelite-desconocido";
  const ip = getClientIp(req);

  const token = await signApiToken(
    { sub: user.id, email: user.email, name: user.name },
    { scope }
  );
  const refresh = await emitirRefreshToken({
    userId: user.id,
    etiqueta,
    scope,
    ip,
  });
  registrarBitacora({
    userId: user.id,
    actorEmail: user.email,
    accion: "token.emitir",
    entidad: "ApiRefreshToken",
    entidadId: refresh.id,
    detalle: { etiqueta, scope: scope ?? null },
    ip,
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
        purifPuesto: true,
        construccionRol: true,
        construccionPaginas: true,
        automotrizPaginas: true,
        hospitalPaginas: true,
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
    /** Encajonamiento de empleados restringidos de purificadora (o null). */
    purifPuesto: string | null;
    /** Rol del satélite de construcción (bartiz), o null = sin restricción. */
    construccionRol: string | null;
    /** Páginas visibles del satélite de construcción; [] = según su rol. */
    construccionPaginas: string[];
    /** Páginas visibles del satélite automotriz; [] = todas (sin restricción). */
    automotrizPaginas: string[];
    /** Páginas visibles del satélite Hospital; [] = todas (sin restricción). */
    hospitalPaginas: string[];
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
      purifPuesto: m.purifPuesto ?? null,
      construccionRol: m.construccionRol ?? null,
      construccionPaginas: m.construccionPaginas ?? [],
      automotrizPaginas: m.automotrizPaginas ?? [],
      hospitalPaginas: m.hospitalPaginas ?? [],
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
        purifPuesto: null, // acceso vía despacho: sin restricción de puesto
        construccionRol: null, // acceso vía despacho: sin rol restringido
        construccionPaginas: [], // acceso vía despacho: ve todas las páginas
        automotrizPaginas: [], // acceso vía despacho: ve todas las páginas
        hospitalPaginas: [], // acceso vía despacho: ve todas las páginas
      });
    }
  }

  // 3. Operador de plataforma: adentro del hub ya opera TODAS las empresas
  //    activas (requireMembership le da OWNER en cualquiera), pero esta lista
  //    sólo traía sus membresías directas y las de su despacho, así que un
  //    satélite le decía «ninguna de tus empresas tiene el módulo» para
  //    empresas que sí puede operar. Se completa con las que faltan.
  if (await isOperador(user.id)) {
    const todas = await prisma.company.findMany({
      where: { isActive: true },
      select: {
        id: true,
        rfc: true,
        razonSocial: true,
        modules: { where: { habilitado: true }, select: { modulo: true } },
      },
    });
    for (const c of todas) {
      if (byId.has(c.id)) continue;
      const modulos = c.modules.map((x) => x.modulo);
      if (modulos.length === 0) continue;
      byId.set(c.id, {
        id: c.id,
        rfc: c.rfc,
        razonSocial: c.razonSocial,
        role: "OWNER",
        modulos,
        purifPuesto: null,
        construccionRol: null,
        construccionPaginas: [],
        automotrizPaginas: [],
        hospitalPaginas: [],
      });
    }
  }

  const companies = Array.from(byId.values());

  return NextResponse.json({
    token,
    // Flujo nuevo: refresh rotatorio + vigencias explícitas. En el flujo
    // legado estas llaves se omiten y la forma queda EXACTAMENTE la histórica.
    ...(refresh
      ? {
          refreshToken: refresh.refreshToken,
          expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
          refreshExpiresIn: REFRESH_TOKEN_EXPIRY_SECONDS,
        }
      : {}),
    user: { id: user.id, email: user.email, name: user.name },
    companies,
  });
}
