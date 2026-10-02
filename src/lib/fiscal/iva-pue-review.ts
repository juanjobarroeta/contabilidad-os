import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import {
  ivaTimingInput,
  loadPueIncomeCollections,
  pueInvoiceInclude,
  pueInvoiceFingerprint,
  pueReviewToken,
} from "./iva-pue-cobros-db";
import type { PueTimingReview } from "./iva-pue-cobros";

export type PueReviewInput = z.infer<typeof ivaTimingInput>;
export type PueReviewProposal = {
  invoiceId: string;
  input: PueReviewInput;
  evidenceExpected: string;
  conversationId: string;
};

export function validatePueReview(input: PueReviewInput): string | null {
  if (!input.fechaCobro) return null;
  const date = new Date(input.fechaCobro + "T00:00:00.000Z");
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== input.fechaCobro ||
    input.fechaCobro > new Date().toISOString().slice(0, 10)
  )
    return "La fecha efectiva de cobro debe ser real y no futura.";
  if (
    input.tratamiento !== "FLUJO_GENERAL" ||
    !input.evidencia ||
    input.evidencia.length < 10
  )
    return "Para confirmar un cobro completo indica la referencia del comprobante y el tratamiento de flujo general.";
  return null;
}

/** Current evidence for one invoice. The hash also binds bank facts and pending
 * issues so a chat card cannot approve evidence that changed after inspection. */
export async function inspectPueCollection(
  companyId: string,
  invoiceId: string,
  snapshot?: Prisma.TransactionClient,
) {
  const read = async (db: Prisma.TransactionClient) => {
    const inv = await db.invoice.findFirst({
      where: { id: invoiceId, companyId },
      include: pueInvoiceInclude,
    });
    if (
      !inv ||
      inv.tipo !== "INGRESO" ||
      inv.metodoPago !== "PUE" ||
      inv.status !== "STAMPED" ||
      inv.sustituidoPorUuid ||
      inv.tipoSat === "E" ||
      inv.moneda !== "MXN"
    )
      throw new Error(
        "No hay un ingreso PUE vigente en MXN con ese ID en esta empresa.",
      );
    const from = new Date(
      Date.UTC(inv.fecha.getUTCFullYear(), inv.fecha.getUTCMonth(), 1),
    );
    const to = new Date(
      Date.UTC(inv.fecha.getUTCFullYear(), inv.fecha.getUTCMonth() + 1, 1),
    );
    const data = await loadPueIncomeCollections(companyId, from, to, db);
    const row = data.rows.find((r) => r.invoice.id === invoiceId);
    if (!row)
      throw new Error("No se pudo obtener evidencia completa del cobro.");
    const expected = createHash("sha256")
      .update(
        JSON.stringify({
          fingerprint: row.fingerprint,
          result: row.result,
          periodos: data.summary.periodosARevisar,
        }),
      )
      .digest("hex");
    return { row, expected, periodosARevisar: data.summary.periodosARevisar };
  };
  return snapshot
    ? read(snapshot)
    : prisma.$transaction(read, {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: 30000,
      });
}

/** Shared write for an authenticated API request or a human-confirmed chat card.
 * The model can only stage a proposal; this function is never an agent tool. */
export async function savePueReview(
  invoiceId: string,
  input: PueReviewInput,
  userId: string,
  chat?: { evidenceExpected: string; conversationId: string },
) {
  const member = await getEffectiveCompanyMembership(userId, input.companyId);
  if (!member || member.role === "VIEWER")
    return {
      error: "Sin permisos para confirmar el tratamiento fiscal.",
      status: 403,
    };
  const invalid = validatePueReview(input);
  if (invalid) return { error: invalid, status: 400 };
  return prisma.$transaction(
    async (db) => {
      await db.$queryRaw`SELECT id FROM "Invoice" WHERE id=${invoiceId} AND "companyId"=${input.companyId} FOR UPDATE`;
      const inv = await db.invoice.findFirst({
        where: { id: invoiceId, companyId: input.companyId },
        include: pueInvoiceInclude,
      });
      if (!inv) return { error: "Factura no encontrada.", status: 404 };
      if (
        inv.tipo !== "INGRESO" ||
        inv.metodoPago !== "PUE" ||
        inv.status !== "STAMPED" ||
        inv.tipoSat === "E" ||
        inv.sustituidoPorUuid ||
        inv.moneda !== "MXN"
      )
        return {
          error:
            "Esta revisión corresponde a ingresos PUE vigentes en MXN; otros supuestos requieren revisión específica.",
          status: 422,
        };
      if (pueReviewToken(inv) !== input.expected)
        return {
          error:
            "La factura o su revisión cambió. Consulta de nuevo la evidencia antes de confirmar.",
          status: 409,
        };
      if (
        chat &&
        (await inspectPueCollection(input.companyId, invoiceId, db))
          .expected !== chat.evidenceExpected
      )
        return {
          error:
            "La evidencia del cobro cambió. Pide a Mochi que revise de nuevo antes de confirmar.",
          status: 409,
        };
      const review: PueTimingReview = {
        version: 1,
        tratamiento: input.tratamiento,
        fechaCobro: input.fechaCobro,
        evidencia: input.evidencia,
        motivo: input.motivo,
        fingerprint: pueInvoiceFingerprint(inv),
        actorId: userId,
        reviewedAt: new Date().toISOString(),
      };
      await db.invoice.update({
        where: { id: invoiceId },
        data: { ivaCausacionRevision: { ...review } },
      });
      await db.auditLog.create({
        data: {
          companyId: input.companyId,
          userId,
          accion: "factura.iva-cobro-revisado",
          entidad: "Invoice",
          entidadId: invoiceId,
          detalle: {
            anterior: inv.ivaCausacionRevision,
            nueva: { ...review },
            origen: chat ? "MOCHI" : "API",
            conversationId: chat?.conversationId ?? null,
          },
        },
      });
      return { ok: true, status: 200 };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 30000,
    },
  );
}
