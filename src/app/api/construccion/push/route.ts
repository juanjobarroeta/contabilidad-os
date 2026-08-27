/**
 * Web Push del satélite de construcción (bartiz).
 *
 * GET    /api/construccion/push          → { configured, publicKey } — la llave
 *        VAPID pública que el navegador necesita para suscribirse. No es
 *        secreta, pero se exige usuario autenticado por higiene.
 * POST   /api/construccion/push          → guarda/refresca la PushSubscription
 *        del usuario (body: { companyId, endpoint, keys: { p256dh, auth } }).
 * DELETE /api/construccion/push?endpoint=... → la elimina (opt-out).
 *
 * Vive bajo /api/construccion/* para heredar el CORS del middleware y el
 * choke point de roles (requireMembership → enforceConstruccionRol): todos
 * los roles del satélite tienen el patrón "push" en su allowlist — cualquiera
 * puede activar sus propias notificaciones.
 *
 * A diferencia de /api/push/subscribe (sólo sesión NextAuth del hub), aquí la
 * autenticación acepta bearer, que es como habla bartiz.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireUser, withAuthz } from "@/lib/authz";

export const GET = withAuthz(async (req: Request) => {
  await requireUser(req);
  const publicKey = process.env.VAPID_PUBLIC_KEY ?? null;
  return NextResponse.json({ configured: !!publicKey, publicKey });
});

const subscribeSchema = z.object({
  companyId: z.string().min(1),
  endpoint: z.string().url().max(1000),
  keys: z.object({
    p256dh: z.string().min(1).max(300),
    auth: z.string().min(1).max(300),
  }),
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = subscribeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Suscripción inválida" }, { status: 400 });
  }
  const { companyId, endpoint, keys } = parsed.data;

  const { user } = await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "CONSTRUCCION");

  await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: { endpoint, p256dh: keys.p256dh, auth: keys.auth, userId: user.id, companyId },
    update: { p256dh: keys.p256dh, auth: keys.auth, userId: user.id, companyId },
  });
  return NextResponse.json({ ok: true });
});

export const DELETE = withAuthz(async (req: Request) => {
  const user = await requireUser(req);
  const endpoint = new URL(req.url).searchParams.get("endpoint");
  if (endpoint) {
    await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: user.id } });
  }
  return NextResponse.json({ ok: true });
});
