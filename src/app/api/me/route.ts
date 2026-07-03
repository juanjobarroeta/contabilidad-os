import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isOperador } from "@/lib/authz";
import { enforcementHabilitado, getUserSubscriptionState } from "@/lib/subscription";

// GET /api/me — datos ligeros del usuario para la UI (p.ej. mostrar herramientas
// internas sólo al operador de plataforma) + estado EFECTIVO de la suscripción
// (con TRIALING vencido ya convertido en EXPIRED) y si el gating de escrituras
// está encendido (SUBSCRIPTION_ENFORCEMENT_ENABLED), para que la UI reaccione
// de forma consistente con el backend.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [esOperador, subscription] = await Promise.all([
    isOperador(session.user.id),
    getUserSubscriptionState(session.user.id),
  ]);

  return NextResponse.json({
    esOperador,
    subscription: {
      status: subscription.status,
      trialEndsAt: subscription.trialEndsAt,
      daysLeft: subscription.daysLeft,
      isActive: subscription.isActive,
      isExpired: subscription.isExpired,
      enforcementEnabled: enforcementHabilitado(),
    },
  });
}

// DELETE /api/me — baja definitiva de la cuenta del usuario actual (LFPDPPP,
// derecho de cancelación).
//
// Regla: si el usuario es el ÚNICO OWNER directo de alguna empresa, se
// responde 409 con la lista — primero debe dar de baja esas empresas (o
// transferir la propiedad; la transferencia está fuera de alcance aquí).
// Así nunca queda una empresa con datos fiscales sin ningún propietario.
//
// Se borran: membresías (CompanyMember/DespachoMember, por cascada del User),
// pendientes del inbox, suscripciones push, vínculos y conversaciones de
// WhatsApp, conversaciones del asistente (cascada), invitaciones PENDING que
// él envió, sesiones/cuentas OAuth (cascada) y la fila User.
//
// Respuesta: 204 — el cliente debe cerrar la sesión (signOut) al recibirla.
export async function DELETE() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;

  // Empresas donde este usuario es OWNER directo…
  const ownerships = await prisma.companyMember.findMany({
    where: { userId, role: "OWNER" },
    select: {
      companyId: true,
      company: { select: { rfc: true, razonSocial: true } },
    },
  });
  // …y de esas, en cuáles es el ÚNICO OWNER.
  const soloOwner: { companyId: string; rfc: string; razonSocial: string }[] = [];
  for (const o of ownerships) {
    const owners = await prisma.companyMember.count({
      where: { companyId: o.companyId, role: "OWNER" },
    });
    if (owners <= 1) {
      soloOwner.push({
        companyId: o.companyId,
        rfc: o.company.rfc,
        razonSocial: o.company.razonSocial,
      });
    }
  }
  if (soloOwner.length > 0) {
    return NextResponse.json(
      {
        error:
          "Eres el único propietario de una o más empresas. Da de baja esas empresas (o transfiere su propiedad) antes de eliminar tu cuenta.",
        empresas: soloOwner,
      },
      { status: 409 }
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  const auditoria = {
    userId,
    email: user?.email ?? session.user.email ?? null,
    timestamp: new Date().toISOString(),
  };
  console.warn(`[baja-cuenta] solicitada ${JSON.stringify(auditoria)}`);

  await prisma.$transaction([
    // Sin FK hacia User — hay que borrarlos explícitamente.
    prisma.notificationItem.deleteMany({ where: { recipientUserId: userId } }),
    prisma.pushSubscription.deleteMany({ where: { userId } }),
    // Invitaciones que él envió y siguen pendientes (las aceptadas se
    // conservan como rastro de cómo obtuvo acceso el invitado).
    prisma.companyInvitation.deleteMany({ where: { invitedByUserId: userId, status: "PENDING" } }),
    // Explícitos por claridad (también caerían por cascada del User):
    // WhatsappLink → WhatsappConversation → WhatsappMessage;
    // ChatConversation → ChatMessage; CompanyMember; DespachoMember.
    prisma.whatsappLink.deleteMany({ where: { userId } }),
    prisma.chatConversation.deleteMany({ where: { userId } }),
    prisma.companyMember.deleteMany({ where: { userId } }),
    prisma.despachoMember.deleteMany({ where: { userId } }),
    // La fila User al final — cascada: Account, Session.
    prisma.user.delete({ where: { id: userId } }),
  ]);

  console.warn(`[baja-cuenta] completada ${JSON.stringify(auditoria)}`);
  // 204: el cliente cierra sesión (signOut) al recibir la respuesta.
  return new NextResponse(null, { status: 204 });
}
