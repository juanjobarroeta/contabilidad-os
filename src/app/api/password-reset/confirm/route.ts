import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashResetToken, evaluarResetToken, MOTIVO_RESET } from "@/lib/password-reset";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { registrarBitacora } from "@/lib/audit";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/password-reset/confirm — PÚBLICO (el usuario no puede iniciar
// sesión). Canjea un token de restablecimiento por una contraseña nueva.
// Un solo uso: la reclamación es un updateMany condicional (usedAt IS NULL),
// así dos canjes concurrentes no pueden ganar ambos.
// Body: { token, newPassword }
// ─────────────────────────────────────────────────────────────────────────────

const schema = z.object({
  token: z.string().min(10),
  newPassword: z.string().min(8, "Mínimo 8 caracteres").max(200),
});

export async function POST(req: Request) {
  const ipLimit = checkRateLimit(`password-reset:ip:${getClientIp(req)}`, {
    limit: 10,
    windowMs: 15 * 60 * 1000,
  });
  if (!ipLimit.ok) {
    return NextResponse.json({ error: "Demasiados intentos. Intenta más tarde." }, { status: 429 });
  }

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Datos inválidos" },
      { status: 400 }
    );
  }

  const tokenHash = hashResetToken(parsed.data.token);
  const token = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true, usedAt: true, expiresAt: true },
  });

  const estado = evaluarResetToken(token, new Date());
  if (!estado.ok) {
    return NextResponse.json({ error: MOTIVO_RESET[estado.motivo] }, { status: 400 });
  }

  // Reclamación atómica de un solo uso ANTES de tocar la contraseña.
  const claimed = await prisma.passwordResetToken.updateMany({
    where: { id: token!.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count === 0) {
    return NextResponse.json({ error: MOTIVO_RESET.usado }, { status: 409 });
  }

  await prisma.user.update({
    where: { id: token!.userId },
    data: { password: await bcrypt.hash(parsed.data.newPassword, 10) },
  });

  registrarBitacora({
    accion: "password-reset.canjear",
    userId: token!.userId,
    entidad: "User",
    entidadId: token!.userId,
    detalle: { tokenId: token!.id },
  });

  return NextResponse.json({ ok: true });
}
