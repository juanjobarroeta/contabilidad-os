import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { esAdminPlataforma } from "@/lib/billing/admin-plataforma";
import { registrarBitacora } from "@/lib/audit";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/billing/override-suscripcion — override MANUAL de suscripción para
// clientes que pagan por TRANSFERENCIA (sin tarjeta). Operacionaliza la
// convención documentada en billing/suspension.ts: "cliente que pagó por
// transferencia = poner su subscriptionStatus = ACTIVE, no hace falta otro
// campo". Con esto el operador ya no depende de un script/SQL:
//
//   { email, accion: "activar" }    → subscriptionStatus = ACTIVE
//   { email, accion: "desactivar" } → subscriptionStatus = CANCELED
//
// ACTIVE desbloquea TODO lo que lee el estado de pago: gate de escritura,
// suspensión, nivel de pago de Syntage (backfill completo) y el slot del RFC.
// "desactivar" es para cuando dejó de pagar la transferencia — el cron
// syntage-liberar-slots recoge su slot después.
//
// Sólo el ADMIN DE PLATAFORMA (PLATFORM_ADMIN_EMAILS) puede llamarlo — es
// quien cobra las transferencias. No toca Stripe: un usuario con suscripción
// de Stripe vigente se administra en Stripe (el webhook pisaría esto).
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  if (!esAdminPlataforma(session.user.email)) {
    return NextResponse.json({ error: "Sólo el admin de plataforma" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { email?: unknown; accion?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const accion = body?.accion;
  if (!email || (accion !== "activar" && accion !== "desactivar")) {
    return NextResponse.json(
      { error: "Body requerido: { email, accion: 'activar' | 'desactivar' }" },
      { status: 400 }
    );
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, subscriptionStatus: true, stripeSubscriptionId: true },
  });
  if (!user) return NextResponse.json({ error: `No existe usuario con email ${email}` }, { status: 404 });

  // Con suscripción de Stripe viva, el override sería pisado por el siguiente
  // webhook — se administra desde Stripe (portal/dashboard), no aquí.
  if (user.stripeSubscriptionId && accion === "activar") {
    return NextResponse.json(
      {
        error:
          "Este usuario tiene una suscripción de Stripe: su estado lo gobierna Stripe (webhook). Administra el cobro desde el dashboard de Stripe.",
      },
      { status: 409 }
    );
  }

  const nuevoStatus = accion === "activar" ? ("ACTIVE" as const) : ("CANCELED" as const);
  await prisma.user.update({
    where: { id: user.id },
    data: { subscriptionStatus: nuevoStatus },
  });

  registrarBitacora({
    companyId: null,
    userId: session.user.id,
    actorEmail: session.user.email ?? null,
    accion: "billing.override-suscripcion",
    entidad: "User",
    entidadId: user.id,
    detalle: { email: user.email, de: user.subscriptionStatus, a: nuevoStatus, motivo: "pago por transferencia" },
    req,
  });

  return NextResponse.json({
    ok: true,
    email: user.email,
    subscriptionStatus: nuevoStatus,
    mensaje:
      accion === "activar"
        ? "Suscripción activada (pago por transferencia). Escritura, Syntage y slot habilitados."
        : "Suscripción cancelada. Sus extracciones se pausan y el cron syntage-liberar-slots liberará su slot.",
  });
}
