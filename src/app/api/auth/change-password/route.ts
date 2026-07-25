import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser, AuthzError } from "@/lib/authz";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * POST /api/auth/change-password — self-serve para cualquier usuario
 * autenticado (sesión web o bearer de satélite). Pide la contraseña actual
 * para evitar que una sesión robada la cambie a ciegas.
 */

const schema = z.object({
  currentPassword: z.string().min(1, "Contraseña actual requerida"),
  newPassword: z.string().min(8, "Mínimo 8 caracteres").max(200),
});

export async function POST(req: Request) {
  try {
    const user = await requireUser(req);

    const limit = checkRateLimit(`change-password:${user.id}`, {
      limit: 5,
      windowMs: 15 * 60 * 1000,
    });
    if (!limit.ok) {
      return NextResponse.json(
        { error: "Demasiados intentos. Intenta más tarde." },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds ?? 60) } }
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Datos inválidos" },
        { status: 400 }
      );
    }

    const dbUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { password: true },
    });
    if (!dbUser?.password) {
      // Cuenta sólo-OAuth: no hay contraseña que cambiar por esta vía.
      return NextResponse.json(
        { error: "Esta cuenta no usa contraseña" },
        { status: 400 }
      );
    }

    const ok = await bcrypt.compare(parsed.data.currentPassword, dbUser.password);
    if (!ok) {
      return NextResponse.json(
        { error: "La contraseña actual no es correcta" },
        { status: 403 }
      );
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { password: await bcrypt.hash(parsed.data.newPassword, 10) },
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthzError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
