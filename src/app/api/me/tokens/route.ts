/**
 * GET    /api/me/tokens          — lista los refresh tokens ACTIVOS del usuario
 *                                  (etiqueta, createdAt, lastUsedAt, ip, expiresAt).
 * DELETE /api/me/tokens          — body { id } revoca uno; { todos: true } revoca todos.
 *
 * Revocar el refresh token corta la renovación de inmediato; el último access
 * token emitido caduca solo en menos de 1 hora (ver src/lib/api-token.ts).
 * Autz: sesión web o bearer — siempre sobre los tokens del PROPIO usuario.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, withAuthz } from "@/lib/authz";
import {
  listarRefreshTokensActivos,
  revocarRefreshTokens,
} from "@/lib/api-refresh-token";
import { registrarBitacora } from "@/lib/audit";
import { getClientIp } from "@/lib/rate-limit";

export const GET = withAuthz(async (req: Request) => {
  const user = await requireUser(req);
  const tokens = await listarRefreshTokensActivos(user.id);
  return NextResponse.json({ tokens });
});

const deleteSchema = z
  .object({
    id: z.string().min(1).optional(),
    todos: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.id) || v.todos === true, {
    message: "Indica el id del token o todos: true",
  });

export const DELETE = withAuthz(async (req: Request) => {
  const user = await requireUser(req);

  const body = await req.json().catch(() => null);
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Indica el id del token a revocar o todos: true" },
      { status: 400 }
    );
  }

  const revocados = await revocarRefreshTokens({
    userId: user.id,
    tokenId: parsed.data.id,
    todos: parsed.data.todos === true,
  });

  if (revocados === 0) {
    return NextResponse.json(
      { error: "Token no encontrado o ya revocado" },
      { status: 404 }
    );
  }

  registrarBitacora({
    userId: user.id,
    actorEmail: user.email,
    accion: "token.revocar",
    entidad: "ApiRefreshToken",
    entidadId: parsed.data.id ?? null,
    detalle: { todos: parsed.data.todos === true, revocados },
    ip: getClientIp(req),
  });

  return NextResponse.json({ ok: true, revocados });
});
