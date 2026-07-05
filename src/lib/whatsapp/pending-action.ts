import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { reconcileTransaction } from "@/lib/conciliacion";
import { resolverPendingImportEstado, type PendingImportEstado } from "@/lib/whatsapp/estado-cuenta";

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp write-action confirmation gate (acciones REVERSIBLES en el chat).
//
// Una conciliación se ESCENIFICA como `pendingAction` con un código de 6 dígitos
// de corta vida; el usuario responde ese código exacto para ejecutar — un "sí"
// pelón NO basta (defiende contra un teléfono secuestrado y envíos accidentales).
//
// Las acciones IRREVERSIBLES/fiscales (timbrar, complemento de pago…) ya NO se
// confirman aquí con un código: viajan por los "rieles" del Tier 3 (deep link a
// una pantalla de revisión y autorización DENTRO de la app). Ver `staged-action.ts`.
// ─────────────────────────────────────────────────────────────────────────────

const TTL_MS = 15 * 60 * 1000; // pending action expires in 15 min

export type PendingAction =
  | {
      type: "conciliar";
      code: string;
      expiresAt: number;
      payload: { txId: string; invoiceId: string };
      preview: string;
      companyId: string;
    }
  // Estado de cuenta recibido por WhatsApp a la espera de que el usuario elija
  // la cuenta bancaria destino (respuesta numerada, no código de 6 dígitos).
  // El payload cachea las filas PARSEADAS, nunca el archivo crudo.
  | PendingImportEstado;

function genCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

// Sólo las acciones con código de confirmación pasan por aquí; el pendiente
// de importación de estado de cuenta se escenifica en estado-cuenta.ts.
async function stage(
  conversationId: string,
  action: Extract<PendingAction, { code: string }>
): Promise<{ code: string }> {
  await prisma.whatsappConversation.update({
    where: { id: conversationId },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { pendingAction: action as any },
  });
  return { code: action.code };
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

  // Selección de cuenta para un estado de cuenta recibido por WhatsApp: se
  // confirma con un NÚMERO de la lista (no con código de 6 dígitos). La
  // lógica vive junto al resto del flujo en estado-cuenta.ts.
  if (pa.type === "importar_estado") {
    return resolverPendingImportEstado(conversationId, pa, body);
  }

  const text = body.trim().toLowerCase();
  if (/^(cancelar|cancela|no)\b/.test(text)) {
    await clearPendingAction(conversationId);
    return "Cancelado. No se realizó la conciliación.";
  }

  const codeMatch = body.trim().match(/\b(\d{6})\b/);
  if (!codeMatch) {
    // They said something else while an action is pending — remind, don't execute.
    return (
      `Tienes una conciliación pendiente de confirmar. Responde con el código *${pa.code}* para proceder, ` +
      "o escribe *cancelar* para descartarla y seguir con otra cosa."
    );
  }
  if (codeMatch[1] !== pa.code) {
    return "Ese código no coincide. Revisa el código de confirmación o escribe *cancelar*.";
  }

  // Correct code → execute the write.
  await clearPendingAction(conversationId);

  try {
    const r = await reconcileTransaction(pa.payload.txId, pa.payload.invoiceId, pa.companyId);
    if (!r.ok) return `No se pudo conciliar: ${r.error}`;
    return `✅ Movimiento conciliado con la factura de ${r.cliente}${r.uuid ? ` (${r.uuid})` : ""}.`;
  } catch (e) {
    console.error("[whatsapp] reconcile error", e);
    return "Hubo un error al conciliar. Inténtalo de nuevo o hazlo desde la app.";
  }
}
