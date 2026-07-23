import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { hashOnboardingToken, evaluarInvitacion } from "@/lib/onboarding-invite";
import { registrarBitacora } from "@/lib/audit";

const signupSchema = z.object({
  name: z.string().trim().min(1, "Nombre requerido").max(120),
  email: z.string().email("Correo inválido").transform((s) => s.toLowerCase().trim()),
  password: z.string().min(8, "Mínimo 8 caracteres").max(200),
  // Token de invitación de onboarding (enlace ?invite= o código tecleado).
  inviteToken: z.string().trim().min(1).max(200).optional(),
});

const TRIAL_DAYS = 15;

const HOUR_MS = 60 * 60 * 1000;

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
  // Límite por IP: frena la creación masiva de cuentas de prueba.
  const ipLimit = checkRateLimit(`signup:ip:${getClientIp(req)}`, {
    limit: 5,
    windowMs: HOUR_MS,
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

  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "Datos inválidos";
    return NextResponse.json({ error: first }, { status: 400 });
  }

  const { name, email, password, inviteToken } = parsed.data;

  // Límite por correo (ya normalizado a minúsculas por el esquema).
  const emailLimit = checkRateLimit(`signup:email:${email}`, {
    limit: 3,
    windowMs: HOUR_MS,
  });
  if (!emailLimit.ok) {
    return tooManyAttempts(emailLimit.retryAfterSeconds);
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json(
      { error: "Ya existe una cuenta con este correo" },
      { status: 409 }
    );
  }

  // ── Invitación de onboarding (opcional) ──────────────────────────────────
  // Si viene un token: se valida ANTES de crear nada. Un token presente pero
  // inválido/usado/expirado se RECHAZA (no se degrada en silencio a prueba
  // normal — el cliente llegó esperando las condiciones de la invitación).
  let invite: {
    id: string; despachoName: string; tierEmpresas: "ASISTENTE" | "AUTOMATIZADO" | "PRO" | "DESPACHO";
    sinCargo: boolean; trialDays: number;
  } | null = null;
  if (inviteToken) {
    const row = await prisma.onboardingInvite.findUnique({
      where: { tokenHash: hashOnboardingToken(inviteToken) },
      select: { id: true, despachoName: true, tierEmpresas: true, sinCargo: true, trialDays: true, status: true, expiresAt: true },
    });
    const estado = evaluarInvitacion(row, new Date());
    if (!estado.ok) {
      return NextResponse.json({ error: "La invitación no es válida (revisa el enlace o pide una nueva)." }, { status: 400 });
    }
    invite = row!;
  }

  const hashed = await bcrypt.hash(password, 10);

  // Sin invitación: prueba normal. Con invitación cortesía: ACTIVE (sin cargo);
  // con invitación no-cortesía: prueba de los días indicados por la invitación.
  const usaCortesia = invite?.sinCargo === true;
  const trialDays = invite ? invite.trialDays : TRIAL_DAYS;
  const trialEndsAt = usaCortesia ? null : new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000);
  const subscriptionStatus = usaCortesia ? "ACTIVE" : "TRIALING";

  // Todo o nada: crear el usuario y, si hay invitación, su despacho + membresía
  // OWNER, y marcar la invitación como usada (un solo uso — condición en el
  // updateMany contra carreras de doble canje).
  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: { name, email, password: hashed, subscriptionStatus, trialEndsAt },
      select: { id: true, email: true, name: true, trialEndsAt: true },
    });

    if (invite) {
      const claimed = await tx.onboardingInvite.updateMany({
        where: { id: invite.id, status: "PENDING" },
        data: { status: "ACCEPTED", acceptedByEmail: email, acceptedAt: new Date() },
      });
      if (claimed.count !== 1) {
        // Otro canje ganó la carrera entre la validación y aquí.
        throw new Error("INVITE_RACE");
      }
      const despacho = await tx.despacho.create({
        data: { name: invite.despachoName, defaultTier: invite.tierEmpresas },
        select: { id: true },
      });
      await tx.despachoMember.create({
        data: { despachoId: despacho.id, userId: u.id, role: "OWNER" },
      });
      await tx.onboardingInvite.update({
        where: { id: invite.id },
        data: { acceptedDespachoId: despacho.id },
      });
    }
    return u;
  }).catch((e) => {
    if (e instanceof Error && e.message === "INVITE_RACE") return null;
    throw e;
  });

  if (!user) {
    return NextResponse.json({ error: "La invitación acaba de usarse. Pide una nueva." }, { status: 409 });
  }

  if (invite) {
    registrarBitacora({
      companyId: null,
      userId: user.id,
      actorEmail: email,
      accion: "onboarding-invite.aceptar",
      entidad: "OnboardingInvite",
      entidadId: invite.id,
      detalle: { despachoName: invite.despachoName, tierEmpresas: invite.tierEmpresas, sinCargo: invite.sinCargo },
      req,
    });
  }

  return NextResponse.json(user, { status: 201 });
}
