import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { gateEscritura } from "@/lib/subscription";
import {
  findChatPendingAction,
  takeChatPendingAction,
  executeChatPendingAction,
  decideConfirm,
} from "@/lib/ai/pending-action";
import { registrarBitacora } from "@/lib/audit";

// POST /api/ai/confirm
//   body { conversationId, token }
//
// El TAP humano que ejecuta la acción reversible PROPUESTA por el asistente. El
// modelo no puede llegar aquí: este endpoint sólo responde a una sesión
// autenticada (el usuario que toca "Confirmar"). Re-valida TODO:
//   - sesión + membresía de la empresa (rechaza VIEWER);
//   - que la conversación sea accesible para el usuario;
//   - que la acción staged exista, no haya expirado (TTL) y el token coincida
//     (un solo uso: se borra al ejecutar);
//   - que la acción siga aplicando (idempotencia re-validada en execute*).
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;

  const body = (await req.json().catch(() => ({}))) as {
    conversationId?: string;
    token?: string;
  };
  const conversationId = body.conversationId;
  if (!conversationId) {
    return NextResponse.json({ error: "conversationId requerido" }, { status: 400 });
  }
  if (typeof body.token !== "string" || !body.token) return NextResponse.json({ error: "Token de propuesta requerido." }, { status: 400 });

  // La conversación debe existir y ser accesible para el usuario (dueño, o
  // compartida con la empresa). Misma regla que /api/ai/chat.
  const conv = await prisma.chatConversation.findUnique({
    where: { id: conversationId },
    select: { userId: true, companyId: true, visibility: true },
  });
  if (!conv) return NextResponse.json({ error: "Conversación no encontrada" }, { status: 404 });
  const acceso = conv.userId === userId || conv.visibility === "COMPANY";
  if (!acceso) return NextResponse.json({ error: "Sin acceso a esta conversación" }, { status: 403 });

  // Membresía de la empresa + rechazo de VIEWER (no puede ejecutar escrituras).
  const member = await getEffectiveCompanyMembership(userId, conv.companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso a esta empresa" }, { status: 403 });
  if (member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos para ejecutar acciones" }, { status: 403 });
  }

  // Gating de suscripción (bandera SUBSCRIPTION_ENFORCEMENT_ENABLED): este
  // endpoint EJECUTA la escritura staged, así que se gatea igual que el chat.
  const gate = await gateEscritura(userId);
  if (gate) return gate;

  // Puede haber varias tarjetas: se busca la del token tocado.
  const pa = await findChatPendingAction(conversationId, body.token);
  const decision = decideConfirm(pa, body.token, Date.now());
  if (decision.status === "none" || decision.status === "mismatch") {
    return NextResponse.json({ error: "Esta propuesta ya fue atendida o ya no existe." }, { status: 409 });
  }
  if (decision.status === "expired") {
    await takeChatPendingAction(conversationId, body.token);
    return NextResponse.json(
      { error: "La propuesta expiró. Pídele al asistente que la genere de nuevo." },
      { status: 409 },
    );
  }

  // Defensa en profundidad: la acción staged DEBE pertenecer a esta empresa.
  if (pa!.companyId !== conv.companyId) {
    await takeChatPendingAction(conversationId, body.token);
    return NextResponse.json({ error: "La acción no corresponde a esta empresa." }, { status: 409 });
  }

  if (["crear_subcuenta", "renombrar_cuenta", "registrar_prestamo", "bank_statement_review", "iva_collection_review"].includes(pa!.type)) {
    const { requireContaBotAccess } = await import("@/lib/contabot/access");
    try {
      await requireContaBotAccess(userId, conv.companyId, conversationId, { requireEnabled: false });
    } catch {
      return NextResponse.json({ error: "Sin permisos para operar esta contabilidad." }, { status: 403 });
    }
  }

  // Compare-and-swap bajo lock: dos taps simultáneos no consumen la misma
  // tarjeta, y sacar ésta no toca las demás pendientes.
  const claimed = await takeChatPendingAction(conversationId, body.token);
  if (!claimed) return NextResponse.json({ error: "La propuesta ya fue atendida o cambió." }, { status: 409 });
  if (req.method === "DELETE") {
    return NextResponse.json({ ok: true, message: "Propuesta cancelada." });
  }

  const result = await executeChatPendingAction(pa!, userId);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 409 });
  }

  // Bitácora de seguridad: acción del asistente confirmada por un humano y
  // ejecutada (fire-and-forget). Se registra el tipo y los ids objetivo.
  registrarBitacora({
    companyId: conv.companyId,
    userId,
    actorEmail: session.user.email ?? null,
    accion: "ai.confirmar",
    entidad: "ChatConversation",
    entidadId: conversationId,
    detalle: {
      tipo: pa!.type,
      objetivo: pa!.payload,
      resumen: pa!.summary,
    },
    req,
  });

  return NextResponse.json({ ok: true, message: result.message });
}

export const DELETE = POST;
