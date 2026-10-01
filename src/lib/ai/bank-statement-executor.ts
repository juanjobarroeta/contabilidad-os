import { prisma } from "@/lib/prisma";
import { requireContaBotAccess } from "@/lib/contabot/access";
import { accountReview, reviewPage, documentPage, previewReview } from "@/lib/bancos/statements/review";
import { scopeSchema, reviewRequestSchema, publicError } from "@/lib/bancos/statements/contract";
import { stageChatPendingAction } from "./pending-action";
import type { ToolContext } from "./tool-executor";
export async function executeBankStatementTool(name: string, input: Record<string, unknown>, companyId: string, context: ToolContext) {
  try {
    if (!context.userId) throw new Error("Hace falta una sesión autorizada para revisar documentos bancarios.");
    const access = await requireContaBotAccess(context.userId, companyId, context.conversationId, { requireEnabled: false });
    if (name === "query_bank_accounts") return JSON.stringify(await prisma.bankAccount.findMany({ where: { companyId },
      select: { id: true, nombre: true, banco: true, moneda: true, tipo: true } }));
    if (name === "consultar_cep_movimiento") {
      if (!access.canWrite) throw new Error("Sin permiso para consultar y guardar evidencia CEP.");
      const { lookupMovementCep } = await import("@/lib/bancos/cep-enriquecer");
      return JSON.stringify(await lookupMovementCep(companyId, String(input.transaction_id ?? "")));
    }
    const scope = scopeSchema.parse({ companyId, bankAccountId: input.bank_account_id, year: input.year, month: input.month });
    if (name === "query_statement_review") {
      const review = await accountReview(scope), cursor = typeof input.cursor === "number" ? input.cursor : 0;
      return JSON.stringify(input.document_id ? documentPage(review, String(input.document_id), cursor) : reviewPage(review, cursor));
    }
    if (!access.canWrite || !context.inApp || !context.conversationId) throw new Error("La decisión requiere confirmación en el chat de la app.");
    const resolution = String(input.resolution);
    const operation = ["KEEP_BOTH", "MERGE"].includes(resolution)
      ? { type: "pair", resolution, primaryId: input.primary_id, secondaryId: input.secondary_id, reason: input.reason }
      : { type: "row", resolution, rowId: input.row_id, ...(input.movement_id ? { movementId: input.movement_id } : {}), reason: input.reason };
    const request = reviewRequestSchema.parse({ ...scope, expected: input.expected, operation });
    const preview = await previewReview(request);
    const pending = await stageChatPendingAction(context.conversationId, companyId, preview.summary,
      { type: "bank_statement_review", payload: { ...request, effectExpected: preview.effectHash } });
    return JSON.stringify({ pending: true, summary: preview.summary, token: pending.token, ledgerEffect: preview.ledgerEffect,
      instruction: "Pide confirmar la tarjeta. La decisión aún no se ejecutó." });
  } catch (e) { return JSON.stringify({ error: publicError(e) }); }
}
