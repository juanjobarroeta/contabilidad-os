import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { stampDraftFromPending, discardDraft, type StampInput, type StampResult } from "@/lib/facturas/stamp";
import { reconcileTransaction } from "@/lib/conciliacion";

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

export type PendingAction =
  | {
      type: "timbrar";
      code: string;
      expiresAt: number;
      payload: StampInput;
      /** Facturapi draft (borrador) id; stamping promotes this exact draft. */
      draftId: string;
      preview: string;
      companyId: string;
    }
  | {
      type: "conciliar";
      code: string;
      expiresAt: number;
      payload: { txId: string; invoiceId: string };
      preview: string;
      companyId: string;
    };

function genCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

async function stage(conversationId: string, action: PendingAction): Promise<{ code: string }> {
  await prisma.whatsappConversation.update({
    where: { id: conversationId },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { pendingAction: action as any },
  });
  return { code: action.code };
}

export async function stagePendingTimbrar(
  conversationId: string,
  companyId: string,
  payload: StampInput,
  draftId: string,
  preview: string
): Promise<{ code: string }> {
  return stage(conversationId, { type: "timbrar", code: genCode(), expiresAt: Date.now() + TTL_MS, payload, draftId, preview, companyId });
}

export async function stagePendingConciliar(
  conversationId: string,
  companyId: string,
  payload: { txId: string; invoiceId: string },
  preview: string
): Promise<{ code: string }> {
  return stage(conversationId, { type: "conciliar", code: genCode(), expiresAt: Date.now() + TTL_MS, payload, preview, companyId });
}

export async function clearPendingAction(conversationId: string): Promise<void> {
  await prisma.whatsappConversation.update({
    where: { id: conversationId },
    // Prisma treats `undefined` as "skip this field" (a no-op). To actually
    // clear a Json column we must use DbNull — this was the bug that left a
    // stamped invoice's pending action lingering and re-prompting for the code.
    data: { pendingAction: Prisma.DbNull },
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

  const accionLabel = pa.type === "conciliar" ? "conciliación" : "factura";

  const text = body.trim().toLowerCase();
  if (/^(cancelar|cancela|no)\b/.test(text)) {
    await clearPendingAction(conversationId);
    // Drop the throwaway Facturapi draft so cancelled prefacturas don't linger.
    if (pa.type === "timbrar") await discardDraft(pa.companyId, pa.draftId);
    return `Cancelado. No se realizó la ${accionLabel}.`;
  }

  const codeMatch = body.trim().match(/\b(\d{6})\b/);
  if (!codeMatch) {
    // They said something else while an action is pending — remind, don't execute.
    return (
      `Tienes una ${accionLabel} pendiente de confirmar. Responde con el código *${pa.code}* para proceder, ` +
      "o escribe *cancelar* para descartarla y seguir con otra cosa."
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
      // Promote the borrador the user reviewed into a stamped CFDI — same draft,
      // so what they validated is exactly what gets timbrado.
      result = await stampDraftFromPending(pa.payload, pa.draftId);
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

  if (pa.type === "conciliar") {
    try {
      const r = await reconcileTransaction(pa.payload.txId, pa.payload.invoiceId, pa.companyId);
      if (!r.ok) return `No se pudo conciliar: ${r.error}`;
      return `✅ Movimiento conciliado con la factura de ${r.cliente}${r.uuid ? ` (${r.uuid})` : ""}.`;
    } catch (e) {
      console.error("[whatsapp] reconcile error", e);
      return "Hubo un error al conciliar. Inténtalo de nuevo o hazlo desde la app.";
    }
  }

  return "Acción desconocida.";
}
