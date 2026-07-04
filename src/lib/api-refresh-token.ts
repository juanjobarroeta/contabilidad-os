/**
 * Refresh tokens opacos para la API de satélites (padel, bartiz, FlotaGob,
 * ZionX...). Complemento del access token corto de src/lib/api-token.ts:
 *
 *   - El secreto es opaco: 32 bytes aleatorios en base64url. En BD sólo vive
 *     su SHA-256 (ApiRefreshToken.tokenHash) — una fuga de la tabla no
 *     permite usar los tokens.
 *   - Vigencia: 30 días. Cada uso lo ROTA: se emite un secreto nuevo y el
 *     anterior queda revocado con replacedById apuntando al sustituto.
 *   - Detección de robo (rotación estándar): presentar un refresh token ya
 *     rotado o revocado revoca LA CADENA COMPLETA de sucesores y responde
 *     401 — si un atacante robó el token viejo, el legítimo dejará de
 *     funcionar y el dueño tendrá que volver a iniciar sesión, cerrando la
 *     ventana del atacante.
 */

import { createHash, randomBytes } from "node:crypto";
import { prisma } from "./prisma";

/** Vigencia de los refresh tokens, en segundos (30 días). */
export const REFRESH_TOKEN_EXPIRY_SECONDS = 30 * 24 * 60 * 60;

/** Genera el secreto opaco de un refresh token (32 bytes, base64url). */
export function generarSecretoRefresh(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 (hex) de un secreto de refresh token — lo único que se persiste. */
export function hashRefreshToken(secreto: string): string {
  return createHash("sha256").update(secreto).digest("hex");
}

export type RefreshEmitido = {
  /** Secreto en claro que se entrega al cliente. NUNCA se persiste. */
  refreshToken: string;
  /** Fila creada (sin el secreto). */
  id: string;
  expiresAt: Date;
};

/**
 * Crea un refresh token nuevo para el usuario y devuelve el secreto en claro
 * (única vez que existe fuera del cliente).
 */
export async function emitirRefreshToken(params: {
  userId: string;
  etiqueta: string;
  scope?: string | null;
  ip?: string | null;
}): Promise<RefreshEmitido> {
  const secreto = generarSecretoRefresh();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_SECONDS * 1000);
  const row = await prisma.apiRefreshToken.create({
    data: {
      tokenHash: hashRefreshToken(secreto),
      userId: params.userId,
      etiqueta: params.etiqueta.slice(0, 120),
      scope: params.scope?.trim() || null,
      expiresAt,
      ip: params.ip ?? null,
    },
    select: { id: true, expiresAt: true },
  });
  return { refreshToken: secreto, id: row.id, expiresAt: row.expiresAt };
}

export type ResultadoRotacion =
  | {
      ok: true;
      /** Secreto nuevo para el cliente. */
      refreshToken: string;
      nuevoId: string;
      expiresAt: Date;
      userId: string;
      etiqueta: string;
      scope: string | null;
    }
  | {
      ok: false;
      /**
       * - "desconocido": el hash no corresponde a ningún token.
       * - "expirado": el token existía pero ya venció.
       * - "reuso": token ya rotado/revocado — robo detectado; la cadena de
       *   sucesores quedó revocada.
       */
      motivo: "desconocido" | "expirado" | "reuso";
      /** Datos para bitácora cuando el token sí existía. */
      userId?: string;
      etiqueta?: string;
      tokenId?: string;
    };

/** Tope defensivo al recorrer la cadena replacedById (evita ciclos basura). */
const MAX_CADENA = 100;

/**
 * Revoca el token dado y toda su cadena de sucesores (replacedById hacia
 * adelante). Devuelve cuántas filas se revocaron.
 */
async function revocarCadena(tokenId: string): Promise<number> {
  let actual: string | null = tokenId;
  let revocados = 0;
  for (let i = 0; i < MAX_CADENA && actual; i++) {
    const fila: { replacedById: string | null; revokedAt: Date | null } | null =
      await prisma.apiRefreshToken.findUnique({
        where: { id: actual },
        select: { replacedById: true, revokedAt: true },
      });
    if (!fila) break;
    if (!fila.revokedAt) {
      await prisma.apiRefreshToken.update({
        where: { id: actual },
        data: { revokedAt: new Date() },
      });
      revocados++;
    }
    actual = fila.replacedById;
  }
  return revocados;
}

/**
 * Valida un refresh token presentado por el cliente y, si es válido, lo ROTA:
 * emite un secreto nuevo, marca el anterior como revocado (replacedById) y
 * actualiza lastUsedAt. Reuso de un token rotado/revocado => revoca la cadena
 * completa y regresa { ok: false, motivo: "reuso" }.
 */
export async function rotarRefreshToken(
  secreto: string,
  opts?: { ip?: string | null }
): Promise<ResultadoRotacion> {
  const hash = hashRefreshToken(secreto);
  const fila = await prisma.apiRefreshToken.findUnique({
    where: { tokenHash: hash },
  });
  if (!fila) return { ok: false, motivo: "desconocido" };

  // Token ya rotado o revocado explícitamente → detección de robo: se revoca
  // toda la descendencia para invalidar también al portador legítimo actual.
  if (fila.revokedAt) {
    await revocarCadena(fila.id);
    return {
      ok: false,
      motivo: "reuso",
      userId: fila.userId,
      etiqueta: fila.etiqueta,
      tokenId: fila.id,
    };
  }

  if (fila.expiresAt.getTime() <= Date.now()) {
    return {
      ok: false,
      motivo: "expirado",
      userId: fila.userId,
      etiqueta: fila.etiqueta,
      tokenId: fila.id,
    };
  }

  // Rotación: nuevo secreto con vigencia fresca; el anterior queda revocado y
  // encadenado (replacedById) para poder detectar reuso posterior.
  const nuevoSecreto = generarSecretoRefresh();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_SECONDS * 1000);
  const nuevo = await prisma.apiRefreshToken.create({
    data: {
      tokenHash: hashRefreshToken(nuevoSecreto),
      userId: fila.userId,
      etiqueta: fila.etiqueta,
      scope: fila.scope,
      expiresAt,
      ip: opts?.ip ?? null,
    },
    select: { id: true, expiresAt: true },
  });
  await prisma.apiRefreshToken.update({
    where: { id: fila.id },
    data: {
      revokedAt: new Date(),
      replacedById: nuevo.id,
      lastUsedAt: new Date(),
    },
  });

  return {
    ok: true,
    refreshToken: nuevoSecreto,
    nuevoId: nuevo.id,
    expiresAt: nuevo.expiresAt,
    userId: fila.userId,
    etiqueta: fila.etiqueta,
    scope: fila.scope,
  };
}

/**
 * Revoca un refresh token del usuario (o todos con `todos: true`). Devuelve
 * cuántas filas activas se revocaron. Sólo toca filas del propio userId —
 * imposible revocar tokens ajenos.
 */
export async function revocarRefreshTokens(params: {
  userId: string;
  tokenId?: string;
  todos?: boolean;
}): Promise<number> {
  const where = {
    userId: params.userId,
    revokedAt: null,
    ...(params.todos ? {} : { id: params.tokenId ?? "" }),
  };
  const res = await prisma.apiRefreshToken.updateMany({
    where,
    data: { revokedAt: new Date() },
  });
  return res.count;
}

/** Lista los refresh tokens ACTIVOS (no revocados, no expirados) del usuario. */
export async function listarRefreshTokensActivos(userId: string) {
  return prisma.apiRefreshToken.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: {
      id: true,
      etiqueta: true,
      scope: true,
      createdAt: true,
      lastUsedAt: true,
      expiresAt: true,
      ip: true,
    },
    orderBy: { createdAt: "desc" },
  });
}
