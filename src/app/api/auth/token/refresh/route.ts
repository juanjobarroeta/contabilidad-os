/**
 * POST /api/auth/token/refresh
 *
 * Renueva el access token de un satélite SIN reenviar credenciales, rotando
 * el refresh token en el mismo paso (el anterior queda revocado; el nuevo lo
 * sustituye — rotación estándar con detección de robo).
 *
 * Request:  { refreshToken: string }
 * Response (200):
 *   {
 *     token: string,           // access JWT de 1 hora (jti + scope heredado)
 *     refreshToken: string,    // secreto NUEVO — descartar el anterior
 *     expiresIn: 3600,
 *     refreshExpiresIn: 2592000
 *   }
 * Errors:
 *   400 body inválido
 *   401 refresh token desconocido, expirado o REUTILIZADO (en cuyo caso la
 *       cadena completa queda revocada — hay que iniciar sesión de nuevo)
 *   429 demasiados intentos por IP
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ACCESS_TOKEN_EXPIRY_SECONDS, signApiToken } from "@/lib/api-token";
import {
  REFRESH_TOKEN_EXPIRY_SECONDS,
  rotarRefreshToken,
} from "@/lib/api-refresh-token";
import { registrarBitacora } from "@/lib/audit";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

const bodySchema = z.object({
  refreshToken: z.string().min(20).max(200),
});

const WINDOW_MS = 15 * 60 * 1000;

export async function POST(req: Request) {
  // Límite por IP contra fuerza bruta de secretos (aunque 32 bytes aleatorios
  // son imposibles de adivinar, no regalamos un oráculo gratuito).
  const ip = getClientIp(req);
  const ipLimit = checkRateLimit(`token-refresh:ip:${ip}`, {
    limit: 30,
    windowMs: WINDOW_MS,
  });
  if (!ipLimit.ok) {
    return NextResponse.json(
      { error: "Demasiados intentos. Intenta de nuevo más tarde." },
      {
        status: 429,
        headers: { "Retry-After": String(ipLimit.retryAfterSeconds ?? 60) },
      }
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Solicitud inválida" }, { status: 400 });
  }

  const resultado = await rotarRefreshToken(parsed.data.refreshToken, { ip });

  if (!resultado.ok) {
    if (resultado.motivo === "reuso") {
      // Robo detectado: un token ya rotado/revocado fue presentado. La cadena
      // completa quedó revocada dentro de rotarRefreshToken.
      registrarBitacora({
        userId: resultado.userId ?? null,
        accion: "token.refresh-reuso",
        entidad: "ApiRefreshToken",
        entidadId: resultado.tokenId ?? null,
        detalle: { etiqueta: resultado.etiqueta ?? null },
        ip,
      });
    }
    // Mensaje uniforme: no distinguimos desconocido/expirado/reuso hacia
    // afuera para no dar señal a un atacante.
    return NextResponse.json(
      { error: "Refresh token inválido. Inicia sesión de nuevo." },
      { status: 401 }
    );
  }

  // El access token necesita email/name; también re-validamos que la cuenta
  // siga activa (un usuario dado de baja no debe poder renovar).
  const user = await prisma.user.findUnique({
    where: { id: resultado.userId },
    select: { id: true, email: true, name: true, subscriptionStatus: true },
  });
  if (
    !user ||
    user.subscriptionStatus === "EXPIRED" ||
    user.subscriptionStatus === "CANCELED"
  ) {
    return NextResponse.json(
      { error: "Suscripción inactiva. Contacta soporte." },
      { status: 403 }
    );
  }

  const token = await signApiToken(
    { sub: user.id, email: user.email, name: user.name },
    { scope: resultado.scope }
  );

  return NextResponse.json({
    token,
    refreshToken: resultado.refreshToken,
    expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
    refreshExpiresIn: REFRESH_TOKEN_EXPIRY_SECONDS,
  });
}
