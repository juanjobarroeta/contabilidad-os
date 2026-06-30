import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { reconcileTransaction } from "@/lib/conciliacion";
import { aprobarSugerencia } from "@/lib/bancos/sugerencias-concepto";
import type { FamiliaConcepto } from "@/lib/bancos/categorizar-concepto";

// ─────────────────────────────────────────────────────────────────────────────
// Gate de acciones del asistente DENTRO de la app (Fase B — "el contador dentro
// de la app").
//
// CONTRATO DE SEGURIDAD (no negociable):
//   1. El modelo NUNCA ejecuta una escritura desde una llamada de herramienta.
//      Una herramienta "proponer_*" sólo STAGEA aquí una propuesta (resumen +
//      payload) sobre la conversación. La ejecución ocurre SÓLO cuando el humano
//      toca "Confirmar" (POST /api/ai/confirm). El modelo no puede auto-confirmar.
//   2. Sólo se permiten acciones REVERSIBLES:
//        - conciliar         (aplicar un match banco↔CFDI)
//        - categorizacion    (aprobar la categoría de un concepto → ledger)
//        - resolver_hallazgo / posponer_hallazgo
//        - marcar_pendiente  (hecho / pospuesto)
//   3. Acciones IRREVERSIBLES (timbrar, dispersar/pagar, presentar al SAT) están
//      PROHIBIDAS como herramientas — no se pueden stagear (ver isReversibleType).
//   4. Stage y confirm re-validan autz e idempotencia. La confirmación es de un
//      solo uso, acotada a la conversación, con TTL.
//
// La confirmación es por TAP (no hay código de 6 dígitos como en WhatsApp): el
// canal in-app ya está autenticado por sesión, y cada confirm re-checa membresía
// y rechaza VIEWER. El tap ES la confirmación.
// ─────────────────────────────────────────────────────────────────────────────

export const PENDING_ACTION_TTL_MS = 15 * 60 * 1000; // 15 min

/** Tipos de acción reversibles que el asistente puede proponer. */
export type PendingActionType =
  | "conciliar"
  | "categorizacion"
  | "resolver_hallazgo"
  | "posponer_hallazgo"
  | "marcar_pendiente";

/** Acciones irreversibles — JAMÁS stageables. Se documentan para los tests. */
export const IRREVERSIBLE_TYPES = ["timbrar", "dispersar", "pagar", "presentar"] as const;

interface BasePending {
  /** Token de un solo uso, ligado a esta conversación. */
  token: string;
  expiresAt: number;
  companyId: string;
  /** Resumen legible (lo que EXACTAMENTE pasará al confirmar). */
  summary: string;
}

export type ChatPendingAction =
  | (BasePending & { type: "conciliar"; payload: { txId: string; invoiceId: string } })
  | (BasePending & { type: "categorizacion"; payload: { txId: string; familia: FamiliaConcepto } })
  | (BasePending & { type: "resolver_hallazgo"; payload: { hallazgoId: string } })
  | (BasePending & {
      type: "posponer_hallazgo";
      payload: { hallazgoId: string; token: "7d" | "30d" | "fin_de_mes" };
    })
  | (BasePending & {
      type: "marcar_pendiente";
      payload: { itemId: string; accion: "hecho" | "posponer" };
    });

/** True si el tipo es una acción reversible permitida (lista blanca estricta). */
export function isReversibleType(type: string): type is PendingActionType {
  return (
    type === "conciliar" ||
    type === "categorizacion" ||
    type === "resolver_hallazgo" ||
    type === "posponer_hallazgo" ||
    type === "marcar_pendiente"
  );
}

/**
 * Decisión PURA: dada la acción staged (o null), el token presentado y el
 * instante actual, ¿se puede confirmar? Testeable sin DB. NO ejecuta nada.
 *
 *   - none      → no hay acción pendiente
 *   - expired   → expiró por TTL (un solo uso ya implícito: tras ejecutar se borra)
 *   - mismatch  → el token no coincide (confirmación de otra propuesta)
 *   - ok        → procede ejecutar
 */
export function decideConfirm(
  pa: ChatPendingAction | null,
  presentedToken: string | undefined,
  now: number,
): { status: "none" | "expired" | "mismatch" | "ok" } {
  if (!pa) return { status: "none" };
  if (pa.expiresAt <= now) return { status: "expired" };
  if (presentedToken && presentedToken !== pa.token) return { status: "mismatch" };
  return { status: "ok" };
}

function genToken(): string {
  // Token opaco — no es un secreto descifrable por el usuario; el tap autenticado
  // es la autorización. Sólo evita confirmar una propuesta vieja por accidente.
  return `pa_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

// ── Persistencia (stage / read / clear) ──────────────────────────────────────

async function persist(conversationId: string, action: ChatPendingAction): Promise<ChatPendingAction> {
  await prisma.chatConversation.update({
    where: { id: conversationId },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { pendingAction: action as any },
  });
  return action;
}

/** Lee la acción pendiente (si existe y no expiró). */
export async function getChatPendingAction(conversationId: string): Promise<ChatPendingAction | null> {
  const conv = await prisma.chatConversation.findUnique({
    where: { id: conversationId },
    select: { pendingAction: true },
  });
  const pa = conv?.pendingAction as ChatPendingAction | null;
  if (!pa || pa.expiresAt <= Date.now()) return null;
  return pa;
}

/** Borra la acción pendiente (DbNull para realmente vaciar la columna Json). */
export async function clearChatPendingAction(conversationId: string): Promise<void> {
  await prisma.chatConversation.update({
    where: { id: conversationId },
    data: { pendingAction: Prisma.DbNull },
  });
}

// ── Stage (lo único que hacen las herramientas "proponer_*") ─────────────────

type StagePayload =
  | { type: "conciliar"; payload: { txId: string; invoiceId: string } }
  | { type: "categorizacion"; payload: { txId: string; familia: FamiliaConcepto } }
  | { type: "resolver_hallazgo"; payload: { hallazgoId: string } }
  | { type: "posponer_hallazgo"; payload: { hallazgoId: string; token: "7d" | "30d" | "fin_de_mes" } }
  | { type: "marcar_pendiente"; payload: { itemId: string; accion: "hecho" | "posponer" } };

/**
 * STAGEA una acción reversible sobre la conversación. NO ejecuta. Devuelve la
 * propuesta con su token. Rechaza tipos irreversibles por contrato.
 */
export async function stageChatPendingAction(
  conversationId: string,
  companyId: string,
  summary: string,
  staged: StagePayload,
): Promise<ChatPendingAction> {
  if (!isReversibleType(staged.type)) {
    throw new Error(`Tipo de acción no permitido para el asistente: ${staged.type}`);
  }
  const action = {
    ...staged,
    token: genToken(),
    expiresAt: Date.now() + PENDING_ACTION_TTL_MS,
    companyId,
    summary,
  } as ChatPendingAction;
  return persist(conversationId, action);
}

// ── Execute (sólo desde el confirm endpoint, tras el tap humano) ─────────────

export type ExecuteResult = { ok: true; message: string } | { ok: false; error: string };

/**
 * Ejecuta la acción ya confirmada. Cada rama REUSA la operación existente y es
 * IDEMPOTENTE + re-validada (rechaza si el estado cambió o ya se hizo). El
 * companyId aquí es el de la acción staged, ya re-verificado contra la membresía
 * en el endpoint de confirm.
 */
export async function executeChatPendingAction(pa: ChatPendingAction): Promise<ExecuteResult> {
  switch (pa.type) {
    case "conciliar": {
      // Reusa reconcileTransaction (mismo apply que stagePendingConciliar/preview).
      // Re-valida que el movimiento siga sin conciliar.
      const tx = await prisma.bankTransaction.findFirst({
        where: { id: pa.payload.txId, companyId: pa.companyId },
        select: { status: true, invoiceId: true },
      });
      if (!tx) return { ok: false, error: "El movimiento ya no existe." };
      if (tx.invoiceId) {
        return { ok: false, error: "El movimiento ya está conciliado; nada que hacer." };
      }
      const r = await reconcileTransaction(pa.payload.txId, pa.payload.invoiceId, pa.companyId);
      if (!r.ok) return { ok: false, error: r.error };
      return {
        ok: true,
        message: `Movimiento conciliado con la factura de ${r.cliente}${r.uuid ? ` (${r.uuid})` : ""}.`,
      };
    }

    case "categorizacion": {
      // Reusa aprobarSugerencia (idempotente: no duplica asientos; ledger).
      const tx = await prisma.bankTransaction.findFirst({
        where: { id: pa.payload.txId, companyId: pa.companyId },
        select: { id: true },
      });
      if (!tx) return { ok: false, error: "El movimiento ya no existe." };
      const r = await aprobarSugerencia(pa.payload.txId, pa.payload.familia);
      if (!r.ok) return { ok: false, error: r.error };
      return {
        ok: true,
        message: r.created
          ? "Movimiento categorizado y registrado en el libro mayor."
          : "El movimiento ya estaba categorizado; no se duplicó el asiento.",
      };
    }

    case "resolver_hallazgo": {
      // Reusa la misma mutación que /api/hallazgos/[id] (estado RESUELTO).
      const h = await prisma.fiscalHallazgo.findFirst({
        where: { id: pa.payload.hallazgoId, companyId: pa.companyId },
        select: { estado: true },
      });
      if (!h) return { ok: false, error: "El hallazgo ya no existe." };
      if (h.estado === "RESUELTO") return { ok: false, error: "El hallazgo ya estaba resuelto." };
      await prisma.fiscalHallazgo.update({
        where: { id: pa.payload.hallazgoId },
        data: { estado: "RESUELTO", posponerHasta: null },
      });
      return { ok: true, message: "Hallazgo marcado como resuelto." };
    }

    case "posponer_hallazgo": {
      const h = await prisma.fiscalHallazgo.findFirst({
        where: { id: pa.payload.hallazgoId, companyId: pa.companyId },
        select: { id: true },
      });
      if (!h) return { ok: false, error: "El hallazgo ya no existe." };
      const hasta = calcPosponerHasta(pa.payload.token);
      await prisma.fiscalHallazgo.update({
        where: { id: pa.payload.hallazgoId },
        data: { estado: "ABIERTO", posponerHasta: hasta },
      });
      return {
        ok: true,
        message: `Hallazgo pospuesto hasta ${hasta.toLocaleDateString("es-MX", { day: "2-digit", month: "long", year: "numeric" })}.`,
      };
    }

    case "marcar_pendiente": {
      // Reusa la misma mutación que /api/notificaciones/[id]. companyId NO basta:
      // el inbox es por usuario; re-validamos por companyId del item (la autz de
      // membresía la hizo el endpoint).
      const item = await prisma.notificationItem.findFirst({
        where: { id: pa.payload.itemId, companyId: pa.companyId },
        select: { estado: true },
      });
      if (!item) return { ok: false, error: "El pendiente ya no existe." };
      if (pa.payload.accion === "hecho") {
        if (item.estado === "HECHO") return { ok: false, error: "El pendiente ya estaba hecho." };
        await prisma.notificationItem.update({
          where: { id: pa.payload.itemId },
          data: { estado: "HECHO", hechoAt: new Date(), posponerHasta: null },
        });
        return { ok: true, message: "Pendiente marcado como hecho." };
      }
      // posponer 7 días (atajo equivalente al de la UI de pendientes)
      const hasta = new Date(Date.now() + 7 * 86400000);
      await prisma.notificationItem.update({
        where: { id: pa.payload.itemId },
        data: { estado: "POSPUESTO", posponerHasta: hasta },
      });
      return {
        ok: true,
        message: `Pendiente pospuesto hasta ${hasta.toLocaleDateString("es-MX", { day: "2-digit", month: "long" })}.`,
      };
    }
  }
}

/** Fecha de snooze para un hallazgo — espeja /api/hallazgos/[id]. */
export function calcPosponerHasta(token: "7d" | "30d" | "fin_de_mes", now = new Date()): Date {
  if (token === "fin_de_mes") {
    return new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  }
  const dias = token === "7d" ? 7 : 30;
  const d = new Date(now);
  d.setDate(d.getDate() + dias);
  return d;
}
