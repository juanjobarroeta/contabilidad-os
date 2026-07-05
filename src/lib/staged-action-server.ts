// ─────────────────────────────────────────────────────────────────────────────
// Tier 3 — rieles de escrituras de alto valor (PARTE SERVIDOR).
//
// Cablea las piezas puras de `staged-action.ts` con Prisma y el timbrado. Aquí
// viven: escenificar (crear el token + fila), leer por token, RECLAMAR de forma
// atómica (candado de un solo uso PENDING→EXECUTING), EJECUTAR por tipo (ruta
// endurecida ya existente), sellar el resultado y AVISAR por la conversación de
// WhatsApp de origen. No carga bajo vitest (importa Facturapi/prisma).
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import type { StagedAction } from "@prisma/client";
import { stampDraftFromPending, discardDraft, type StampInput } from "@/lib/facturas/stamp";
import { sendWhatsappMessage } from "@/lib/whatsapp/twilio";
import {
  mintStagedToken,
  hashStagedToken,
  buildAuthorizeUrl,
  stagedActionExpiry,
  type StagedActionType,
} from "@/lib/staged-action";

// ── Payloads por tipo de acción ──────────────────────────────────────────────

/** Timbrar: promueve un borrador de Facturapi ya revisado a un CFDI timbrado. */
export interface StagedTimbrarPayload {
  stampInput: StampInput;
  draftId: string;
  /** Texto de la prefactura (lo que se mostró/mostrará en la revisión). */
  previewText: string;
  /** Datos mínimos para pintar la pantalla de revisión sin recomputar. */
  resumen: {
    cliente: string;
    rfc: string;
    subtotal: number;
    iva: number;
    total: number;
    metodoPago: string;
    usoCfdi: string;
  };
}

export type StagedPayload = StagedTimbrarPayload;

// ── Escenificar ──────────────────────────────────────────────────────────────

export async function createStagedAction(opts: {
  type: StagedActionType;
  companyId: string;
  createdByUserId: string;
  whatsappConversationId?: string | null;
  summary: string;
  payload: StagedPayload;
}): Promise<{ id: string; rawToken: string; url: string }> {
  const { rawToken, tokenHash } = mintStagedToken();
  const action = await prisma.stagedAction.create({
    data: {
      tokenHash,
      type: opts.type,
      companyId: opts.companyId,
      createdByUserId: opts.createdByUserId,
      whatsappConversationId: opts.whatsappConversationId ?? null,
      summary: opts.summary,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payload: opts.payload as any,
      expiresAt: stagedActionExpiry(),
    },
    select: { id: true },
  });
  return { id: action.id, rawToken, url: buildAuthorizeUrl(rawToken) };
}

/** Lee la acción por su token crudo (busca por hash). null si no existe. */
export async function getStagedActionByRawToken(rawToken: string): Promise<StagedAction | null> {
  return prisma.stagedAction.findUnique({ where: { tokenHash: hashStagedToken(rawToken) } });
}

/**
 * RECLAMA la acción para ejecutarla: transición atómica PENDING→EXECUTING vía
 * updateMany con guarda de estado y expiración. Solo UN confirm gana (idempotencia
 * / anti doble-timbrado). Devuelve true si este llamador se quedó con el candado.
 */
export async function claimStagedAction(id: string, confirmingUserId: string): Promise<boolean> {
  const r = await prisma.stagedAction.updateMany({
    where: { id, status: "PENDING", expiresAt: { gt: new Date() } },
    data: { status: "EXECUTING", confirmedAt: new Date(), confirmedByUserId: confirmingUserId },
  });
  return r.count === 1;
}

/** Marca CANCELLED (solo si sigue PENDING). Descarta el borrador de Facturapi. */
export async function cancelStagedAction(action: StagedAction): Promise<boolean> {
  const r = await prisma.stagedAction.updateMany({
    where: { id: action.id, status: "PENDING" },
    data: { status: "CANCELLED" },
  });
  if (r.count === 1 && action.type === "timbrar") {
    const payload = action.payload as unknown as StagedTimbrarPayload;
    await discardDraft(action.companyId, payload.draftId).catch(() => {});
  }
  return r.count === 1;
}

// ── Ejecutar (tras el candado) ───────────────────────────────────────────────

export type ExecuteStagedResult =
  | { ok: true; uuid?: string; message: string }
  | { ok: false; error: string };

/**
 * Ejecuta la acción YA reclamada por su tipo, reusando la ruta endurecida.
 * El llamador (el endpoint de confirm) ya validó sesión, membresía (rechaza
 * VIEWER) y gating de suscripción.
 */
export async function executeStagedAction(action: StagedAction): Promise<ExecuteStagedResult> {
  switch (action.type) {
    case "timbrar": {
      const payload = action.payload as unknown as StagedTimbrarPayload;
      let result;
      try {
        result = await stampDraftFromPending(payload.stampInput, payload.draftId);
      } catch (e) {
        console.error("[staged-action] stamp lanzó", e);
        // Ambigüedad del timbrado: no sabemos si el PAC alcanzó a timbrar. Se
        // marca FAILED (un solo uso, sin reintento con el mismo token) y se pide
        // verificar en la app antes de rearmar — nunca se re-timbra a ciegas.
        return {
          ok: false,
          error: "Hubo un error al timbrar. Revisa en la app si la factura quedó antes de volver a intentar.",
        };
      }
      if (!result.ok) return { ok: false, error: result.error };
      return {
        ok: true,
        uuid: result.uuid,
        message:
          `✅ Factura timbrada.\n` +
          `Folio fiscal: ${result.uuid}\n` +
          `Total: ${result.total.toLocaleString("es-MX", { style: "currency", currency: "MXN" })}\n` +
          `Pídeme el XML/PDF cuando lo necesites.`,
      };
    }
    default:
      return { ok: false, error: `Acción no soportada: ${action.type}` };
  }
}

/** Sella el desenlace de una acción EXECUTING → DONE o FAILED. */
export async function finalizeStagedAction(
  id: string,
  outcome: { ok: true; uuid?: string } | { ok: false; error: string }
): Promise<void> {
  await prisma.stagedAction.update({
    where: { id },
    data: outcome.ok
      ? { status: "DONE", resultUuid: outcome.uuid ?? null, error: null }
      : { status: "FAILED", error: outcome.error },
  });
}

/**
 * Avisa el resultado por la conversación de WhatsApp de origen (best-effort).
 * Persiste el mensaje del asistente y lo envía por REST. Nunca lanza.
 */
export async function notifyWhatsappResult(
  whatsappConversationId: string | null,
  text: string
): Promise<void> {
  if (!whatsappConversationId) return;
  try {
    const conv = await prisma.whatsappConversation.findUnique({
      where: { id: whatsappConversationId },
      select: { link: { select: { phoneE164: true } } },
    });
    const phone = conv?.link?.phoneE164;
    if (!phone) return;
    await prisma.whatsappMessage.create({
      data: { conversationId: whatsappConversationId, role: "ASSISTANT", body: text },
    });
    await sendWhatsappMessage(phone, text);
  } catch (e) {
    console.error("[staged-action] no se pudo avisar por WhatsApp", e);
  }
}
