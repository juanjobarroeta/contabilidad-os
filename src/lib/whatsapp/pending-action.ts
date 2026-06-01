import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { stampInvoice, type StampInput, type StampResult } from "@/lib/facturas/stamp";

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp write-action confirmation gate.
//
// A write (e.g. timbrar) is NEVER executed directly by the agent. Instead the
// agent stages it as a `pendingAction` on the conversation with a short-lived
// 6-digit confirmation code. The user must reply with that exact code to
// execute — a bare "sí" is intentionally NOT enough (defends against a hijacked
// phone and accidental sends of a billable, legally-binding CFDI).
// ─────────────────────────────────────────────────────────────────────────────

const TTL_MS = 15 * 60 * 1000; // pending action expires in 15 min

export type PendingAction = {
  type: "timbrar";
  code: string; // 6-digit confirmation code
  expiresAt: number; // epoch ms
  payload: StampInput;
  preview: string; // human summary shown to the user
};

function genCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

export async function stagePendingTimbrar(
  conversationId: string,
  payload: StampInput,
  preview: string
): Promise<{ code: string }> {
  const code = genCode();
  const action: PendingAction = { type: "timbrar", code, expiresAt: Date.now() + TTL_MS, payload, preview };
  await prisma.whatsappConversation.update({
    where: { id: conversationId },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { pendingAction: action as any },
  });
  return { code };
}

export async function clearPendingAction(conversationId: string): Promise<void> {
  await prisma.whatsappConversation.update({
    where: { id: conversationId },
    data: { pendingAction: undefined },
  });
}

/** Read the conversation's pending action, if any (and not expired). */
export async function getPendingAction(conversationId: string): Promise<PendingAction | null> {
  const conv = await prisma.whatsappConversation.findUnique({
    where: { id: conversationId },
    select: { pendingAction: true },
  });
  const pa = conv?.pendingAction as PendingAction | null;
  if (!pa || pa.expiresAt < Date.now()) return null;
  return pa;
}

/**
 * If the message is a confirmation of the pending action, execute it. Returns a
 * user-facing result string, or null if this message isn't a confirmation
 * attempt (so the normal agent should handle it).
 *
 * Confirmation requires the exact 6-digit code. "cancelar" aborts.
 */
export async function tryConfirmPendingAction(
  conversationId: string,
  body: string
): Promise<string | null> {
  const pa = await getPendingAction(conversationId);
  if (!pa) return null;

  const text = body.trim().toLowerCase();
  if (/^(cancelar|cancela|no)\b/.test(text)) {
    await clearPendingAction(conversationId);
    return "Cancelado. No se timbró nada.";
  }

  const codeMatch = body.trim().match(/\b(\d{6})\b/);
  if (!codeMatch) {
    // They said something else while an action is pending — remind, don't execute.
    return (
      `Tienes una factura pendiente de confirmar. Para timbrarla, responde con el código *${pa.code}*. ` +
      "Para cancelar, escribe *cancelar*."
    );
  }
  if (codeMatch[1] !== pa.code) {
    return "Ese código no coincide. Revisa el código de confirmación o escribe *cancelar*.";
  }

  // Correct code → execute the write.
  await clearPendingAction(conversationId);
  if (pa.type === "timbrar") {
    let result: StampResult;
    try {
      result = await stampInvoice(pa.payload);
    } catch (e) {
      console.error("[whatsapp] stamp error", e);
      return "Hubo un error al timbrar. No se generó la factura. Inténtalo de nuevo o hazlo desde la app.";
    }
    if (!result.ok) return `No se pudo timbrar: ${result.error}`;
    return (
      `✅ Factura timbrada.\n` +
      `Folio fiscal: ${result.uuid}\n` +
      `Total: ${result.total.toLocaleString("es-MX", { style: "currency", currency: "MXN" })}\n` +
      `Pídeme el XML/PDF cuando lo necesites.`
    );
  }
  return "Acción desconocida.";
}
