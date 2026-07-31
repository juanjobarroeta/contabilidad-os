import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { esAdminPlataforma } from "@/lib/billing/admin-plataforma";
import { mintResetToken, resetTokenExpiry } from "@/lib/password-reset";
import { registrarBitacora } from "@/lib/audit";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/password-reset/admin — SÓLO admin de plataforma.
// Genera un enlace de restablecimiento de un solo uso (30 min) para un usuario
// que no puede entrar. Mientras no haya proveedor SMTP, el admin lo entrega por
// el canal que ya usa con el cliente (WhatsApp/correo). El token crudo sale UNA
// vez en la respuesta; sólo su hash queda en la base.
// Body: { email }
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email || !esAdminPlataforma(session.user.email, process.env)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const email = String(body?.email ?? "").trim();
  if (!email) return NextResponse.json({ error: "email requerido" }, { status: 400 });

  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true, email: true, name: true },
  });
  if (!user) return NextResponse.json({ error: `No existe un usuario con el correo ${email}` }, { status: 404 });

  const { rawToken, tokenHash } = mintResetToken();
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      createdByEmail: session.user.email,
      tokenHash,
      expiresAt: resetTokenExpiry(),
    },
  });

  registrarBitacora({
    accion: "password-reset.generar",
    userId: session.user.id ?? undefined,
    entidad: "User",
    entidadId: user.id,
    detalle: { paraEmail: user.email },
  });

  const base =
    process.env.NEXTAUTH_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "");
  return NextResponse.json({
    ok: true,
    email: user.email,
    nombre: user.name,
    link: `${base}/reset-password?token=${rawToken}`,
    expiraEnMin: 30,
  });
}
