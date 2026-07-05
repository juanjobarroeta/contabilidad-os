import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { gateEscritura } from "@/lib/subscription";
import { registrarBitacora } from "@/lib/audit";
import { checkStagedActionUsable, stagedActionErrorMessage } from "@/lib/staged-action";
import {
  getStagedActionByRawToken,
  claimStagedAction,
  cancelStagedAction,
  executeStagedAction,
  finalizeStagedAction,
  notifyWhatsappResult,
} from "@/lib/staged-action-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ token: string }> };

const GATE_STATUS: Record<string, number> = {
  not_found: 404,
  expired: 410,
  used: 409,
  cancelled: 410,
};

// POST /api/autorizar/[token] — confirmar | cancelar una acción escenificada
// (Tier 3). Requiere sesión (el enlace vive bajo /(app), autenticado). Re-valida
// membresía (rechaza VIEWER), gating de suscripción, y ejecuta de forma atómica
// (un solo uso) por la ruta endurecida. Avisa el resultado por WhatsApp de origen.
export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Inicia sesión para autorizar." }, { status: 401 });
  }
  const userId = session.user.id;

  const { token } = await params;
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  const intent = body.action === "cancelar" ? "cancelar" : "confirmar";

  const action = await getStagedActionByRawToken(token);

  // Reja de estado/expiración (PURA).
  const gate = checkStagedActionUsable(action);
  if (gate) {
    return NextResponse.json(
      { ok: false, error: stagedActionErrorMessage(gate) },
      { status: GATE_STATUS[gate] ?? 409 }
    );
  }
  // action es no-null aquí (checkStagedActionUsable devolvió null).
  const staged = action!;

  // Autorización: membresía efectiva en la empresa; VIEWER no escribe.
  const membership = await getEffectiveCompanyMembership(userId, staged.companyId);
  if (!membership || membership.role === "VIEWER") {
    return NextResponse.json(
      { ok: false, error: "No tienes permiso para autorizar acciones en esta empresa." },
      { status: 403 }
    );
  }

  if (intent === "cancelar") {
    const cancelled = await cancelStagedAction(staged);
    registrarBitacora({
      accion: "staged.cancelar",
      userId,
      companyId: staged.companyId,
      entidad: "StagedAction",
      entidadId: staged.id,
      detalle: { tipo: staged.type },
    });
    return NextResponse.json({ ok: cancelled, cancelled });
  }

  // Gating de suscripción (falla cerrado con 402 si aplica) — antes de consumir.
  const blocked = await gateEscritura(userId);
  if (blocked) return blocked;

  // Candado atómico de un solo uso: PENDING→EXECUTING. Solo un confirm gana.
  const claimed = await claimStagedAction(staged.id, userId);
  if (!claimed) {
    return NextResponse.json(
      { ok: false, error: "Esta acción ya se está procesando o expiró. Solicítala de nuevo por WhatsApp." },
      { status: 409 }
    );
  }

  const result = await executeStagedAction(staged);
  await finalizeStagedAction(staged.id, result.ok ? { ok: true, uuid: result.uuid } : { ok: false, error: result.error });

  registrarBitacora({
    accion: "staged.confirmar",
    userId,
    companyId: staged.companyId,
    entidad: "StagedAction",
    entidadId: staged.id,
    detalle: { tipo: staged.type, ok: result.ok, uuid: result.ok ? result.uuid : undefined, error: result.ok ? undefined : result.error },
  });

  // Avisa el resultado por la conversación de WhatsApp de origen (best-effort).
  await notifyWhatsappResult(
    staged.whatsappConversationId,
    result.ok ? result.message : `No se pudo timbrar la factura autorizada: ${result.error}`
  );

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  }
  return NextResponse.json({ ok: true, uuid: result.uuid, message: result.message });
}
