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
 *     scope?: string,     // scopes separados por espacio, p. ej. "clientes facturas"
 *     legacy?: boolean    // token de 7 días SIN refresh — sólo si
 *                         // LEGACY_API_TOKENS_ENABLED="true" (deprecado)
 *   }
 *
 * Response (200), flujo normal:
 *   {
 *     token: string,            // access JWT de 1 hora (con jti y scope opcional)
 *     refreshToken: string,     // secreto opaco de 30 días, ROTATORIO
 *     expiresIn: 3600,
 *     refreshExpiresIn: 2592000,
 *     user:  { id, email, name },
 *     companies: Array<{ id, rfc, razonSocial, role, modulos: ModuloApp[] }>
 *   }
 * Con { legacy: true } y la bandera activa: la forma HISTÓRICA
 *   { token (7 días), user, companies } — sin refreshToken.
 *
 * Renovación: POST /api/auth/token/refresh. Revocación: /api/me/tokens.
 * Guía de migración para satélites: docs/API-TOKENS.md.
 *
 * Errors: 400 invalid body, 401 bad credentials, 403 trial expired / legacy
 * deshabilitado.
 */

import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  ACCESS_TOKEN_EXPIRY_SECONDS,
  legacyApiTokensEnabled,
  signApiToken,
  signLegacyApiToken,
} from "@/lib/api-token";
import {
  emitirRefreshToken,
  REFRESH_TOKEN_EXPIRY_SECONDS,
} from "@/lib/api-refresh-token";
import { registrarBitacora } from "@/lib/audit";
import { effectiveModules } from "@/lib/module-access";
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
  legacy: z.boolean().optional(),
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

  const { email, password, cliente, scope, legacy } = parsed.data;

  // La emisión legada (7 días, sin refresh ni revocación) está deprecada y
  // sólo se permite con la bandera explícita — los tokens legados YA emitidos
  // siguen verificando hasta expirar, esto sólo bloquea emitir nuevos.
  if (legacy && !legacyApiTokensEnabled()) {
    return NextResponse.json(
      {
        error:
          "La emisión de tokens legados de 7 días está deshabilitada. Usa el flujo con refreshToken (ver docs/API-TOKENS.md).",
      },
      { status: 403 }
    );
  }

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

  let token: string;
  let refresh: Awaited<ReturnType<typeof emitirRefreshToken>> | null = null;

  if (legacy) {
    // Flujo DEPRECADO: JWT de 7 días sin refresh ni revocación.
    console.warn(
      `[api-token] DEPRECADO: token legado de 7 días emitido para ${user.email} (cliente: ${etiqueta}). Migrar al flujo con refreshToken — ver docs/API-TOKENS.md.`
    );
    token = await signLegacyApiToken({
      sub: user.id,
      email: user.email,
      name: user.name,
    });
    registrarBitacora({
      userId: user.id,
      actorEmail: user.email,
      accion: "token.emitir",
      entidad: "ApiRefreshToken",
      detalle: { etiqueta, legacy: true, vigencia: "7d" },
      ip,
    });
  } else {
    token = await signApiToken(
      { sub: user.id, email: user.email, name: user.name },
      { scope }
    );
    refresh = await emitirRefreshToken({
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
      detalle: { etiqueta, scope: scope ?? null, legacy: false },
      ip,
    });
  }

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
