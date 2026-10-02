import { z } from "zod";
import { requireContaBotAccess } from "@/lib/contabot/access";
import { ivaTimingInput } from "@/lib/fiscal/iva-pue-cobros-db";
import {
  inspectPueCollection,
  validatePueReview,
} from "@/lib/fiscal/iva-pue-review";
import { stageChatPendingAction } from "./pending-action";
import type { ToolContext } from "./tool-executor";

export async function executePueIvaTool(
  name: string,
  input: Record<string, unknown>,
  companyId: string,
  context: ToolContext,
) {
  try {
    if (!["query_iva_cobro", "proponer_revision_iva_cobro"].includes(name))
      throw new Error("Herramienta de revisión de IVA no disponible.");
    if (!context.userId)
      throw new Error("Hace falta una sesión autorizada para revisar el IVA.");
    const access = await requireContaBotAccess(
      context.userId,
      companyId,
      context.conversationId,
      { requireEnabled: false },
    );
    const id = z.string().min(1).parse(input.invoice_id);
    const current = await inspectPueCollection(companyId, id);
    const { row } = current;
    if (name === "query_iva_cobro") {
      const cursor = z.number().int().min(0).default(0).parse(input.cursor);
      const evidence = row.result.evidencia.slice(cursor, cursor + 50);
      return JSON.stringify({
        invoice_id: id,
        uuid: row.invoice.uuid,
        fecha_cfdi: row.result.fechaCfdi,
        total: row.invoice.total,
        conceptos: row.invoice.items.slice(0, 50),
        total_conceptos: row.invoice.items.length,
        impuestos: row.invoice.taxes,
        revision: row.review,
        determinado: row.result.determinado,
        fuente: row.result.fuente,
        fechas_cobro: row.result.fechasCobro,
        incidencias: row.result.incidencias,
        evidencia: evidence,
        total_evidencias: row.result.evidencia.length,
        next_cursor:
          cursor + 50 < row.result.evidencia.length ? cursor + 50 : null,
        expected: current.expected,
        periodos_a_revisar: current.periodosARevisar,
        instruccion:
          "Resuelve en esta conversación usando evidencia y herramientas. Si el motor ya lo determina, explica el resultado sin pedir otra revisión. No cambies la fecha del CFDI para cambiar el mes de IVA.",
      });
    }
    if (!access.canWrite || !context.inApp || !context.conversationId)
      throw new Error(
        "Esta decisión requiere Confirmar en el chat de Mochi con permiso de escritura.",
      );
    if (input.expected !== current.expected)
      throw new Error(
        "La evidencia cambió. Consulta query_iva_cobro de nuevo antes de proponer.",
      );
    const review = ivaTimingInput.parse({
      companyId,
      expected: row.fingerprint,
      tratamiento: input.tratamiento,
      fechaCobro: input.fecha_cobro ?? null,
      evidencia: input.evidencia ?? null,
      motivo: input.motivo,
    });
    const invalid = validatePueReview(review);
    if (invalid) throw new Error(invalid);
    const dates =
      review.fechaCobro ??
      (row.result.fechasCobro.join(", ") || "pendientes de comprobar");
    const summary =
      `CFDI ${row.invoice.uuid ?? id}, emitido ${row.result.fechaCfdi}, por ${row.invoice.total.toLocaleString("es-MX", { style: "currency", currency: "MXN" })}. ` +
      `Cobro: ${dates}. ${review.tratamiento === "FLUJO_GENERAL" ? "Registrar tratamiento de IVA por cobro efectivo con el desglose actual del CFDI." : "Mantener el tratamiento especial pendiente de revisión."} ` +
      (review.evidencia ? `Evidencia: ${review.evidencia}. ` : "") +
      `Fundamento y hechos: ${review.motivo}. ` +
      "El motor recalculará el mes del cobro y conservará pendientes si hay contradicciones. No se cambian el CFDI, las pólizas ni las declaraciones guardadas.";
    const pending = await stageChatPendingAction(
      context.conversationId,
      companyId,
      summary,
      {
        type: "iva_collection_review",
        payload: {
          invoiceId: id,
          input: review,
          evidenceExpected: current.expected,
          conversationId: context.conversationId,
        },
      },
    );
    return JSON.stringify({
      pending: true,
      summary,
      token: pending.token,
      instruction:
        "Muestra la tarjeta existente de Confirmar. La revisión todavía no se aplicó. Después consulta query_tax_position para verificar el resultado; no pidas llenar otro formulario.",
    });
  } catch (e) {
    return JSON.stringify({
      error:
        e instanceof z.ZodError
          ? "Argumentos incompletos o inválidos para revisar el cobro."
          : e instanceof Error
            ? e.message
            : "No se pudo revisar el cobro.",
    });
  }
}
