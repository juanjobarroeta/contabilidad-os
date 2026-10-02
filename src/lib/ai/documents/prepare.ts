import { createHash } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { assertPuedeEscribir } from "@/lib/subscription";
import { crearPrefactura } from "@/lib/facturas/prefacturas";
import { prefacturaSchema } from "@/lib/facturas/prefactura";
import { createPayrollRun } from "@/lib/nomina/payroll-run";
import type { DocumentRef } from "./contract";

export const fiscalDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const date = new Date(s + "T12:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === s;
}, "Fecha inválida");
const taxSchema = z.object({ type: z.enum(["IVA", "ISR", "IEPS"]), rate: z.number().min(0).max(1), factor: z.enum(["Tasa", "Exento"]), withholding: z.boolean() }).strict()
  .refine((t) => t.factor !== "Exento" || (t.type === "IVA" && t.rate === 0 && !t.withholding), "Revisa el desglose exento.");
export const prepareInvoiceSchema = z.object({
  customer_id: z.string().min(1), forma_pago: z.string().regex(/^\d{2}$/), metodo_pago: z.enum(["PUE", "PPD"]), uso_cfdi: z.string().regex(/^[A-Z]{1,2}\d{2}$/), notes: z.string().max(2000).optional(),
  global: z.object({ periodicity: z.enum(["day", "week", "fortnight", "month", "two_months"]), months: z.string().regex(/^(0[1-9]|1[0-8])$/), year: z.number().int().min(2000).max(2100) }).strict().optional(),
  items: z.array(z.object({ description: z.string().trim().min(1).max(1000), product_key: z.string().regex(/^\d{8}$/), unit_key: z.string().regex(/^[A-Z0-9]{2,3}$/), quantity: z.number().positive(), unit_price: z.number().positive(), taxes: z.array(taxSchema).max(10) }).strict()).min(1).max(100),
}).strict().refine((i) => i.metodo_pago === "PPD" ? i.forma_pago === "99" : i.forma_pago !== "99", "PPD usa forma 99; PUE requiere la forma de pago real.");
export const preparePayrollSchema = z.object({
  employee_ids: z.array(z.string().min(1)).min(1).max(100).refine((ids) => new Set(ids).size === ids.length),
  periodo_inicio: fiscalDay, periodo_fin: fiscalDay, fecha_pago: fiscalDay, dias_pagados: z.number().positive().max(31),
}).strict().refine((i) => i.periodo_inicio <= i.periodo_fin, "El fin precede al inicio del periodo.");

/** Same user turn + normalized input returns the same draft. The durable claim
 * is committed before provider calls; uncertain calls are never auto-replayed. */
export async function prepareDocument(name: string, raw: Record<string, unknown>, companyId: string, userId: string, conversationId: string, userMessageId?: string) {
  await assertPuedeEscribir(userId);
  const input = name === "preparar_prefactura" ? prepareInvoiceSchema.parse(raw) : preparePayrollSchema.parse(raw);
  let message = userMessageId
    ? await prisma.chatMessage.findFirst({ where: { id: userMessageId, conversationId, role: "user" }, select: { id: true, createdAt: true, meta: true } })
    : null;
  if (userMessageId && !message) throw new Error("No se encontró la solicitud de este turno.");
  // Automatic follow-ups do not mint new invoice intents. Tie their work to
  // the preceding human request so a resumed model cannot duplicate a draft.
  if (!message || (message.meta as { seguimiento?: boolean } | null)?.seguimiento) {
    const preceding = await prisma.chatMessage.findMany({ where: { conversationId, role: "user", ...(message ? { createdAt: { lte: message.createdAt } } : {}) }, orderBy: { createdAt: "desc" }, take: 50, select: { id: true, createdAt: true, meta: true } });
    message = preceding.find((m) => !(m.meta as { seguimiento?: boolean } | null)?.seguimiento) ?? null;
  }
  if (!message) throw new Error("Hace falta la solicitud del usuario en esta conversación.");
  const key = createHash("sha256").update(JSON.stringify(["mochi-document-prepare-v1", companyId, conversationId, message.id, name, input])).digest("hex");
  let action;
  try {
    action = await prisma.stagedAction.create({ data: { tokenHash: key, type: "mochi_document_prepare", companyId, createdByUserId: userId, summary: name, payload: { conversationId, input, name }, status: "EXECUTING", expiresAt: new Date(Date.now() + 30 * 60_000) } });
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
    const prior = await prisma.stagedAction.findUniqueOrThrow({ where: { tokenHash: key } });
    if (prior.status === "DONE") return prior.payload as { documents: DocumentRef[] };
    throw new Error(prior.status === "EXECUTING" ? "La preparación sigue en curso. Consulta los documentos antes de repetirla." : "La preparación anterior no se completó. Revisa los documentos existentes antes de volver a solicitarla.");
  }
  try {
    let ref: DocumentRef;
    let warnings: string[] = [];
    if (name === "preparar_prefactura") {
      const i = prepareInvoiceSchema.parse(input);
      const customer = await prisma.customer.findFirst({ where: { id: i.customer_id, companyId }, select: { id: true, rfc: true } });
      if (!customer) throw new Error("El cliente no pertenece a esta empresa.");
      if (customer.rfc === "XAXX010101000" && !i.global) throw new Error("La factura global requiere periodicidad, meses y ejercicio explícitos. Pregunta esos datos antes de preparar el documento.");
      const payload = prefacturaSchema.parse({ companyId, customerId: customer.id, formaPago: i.forma_pago, metodoPago: i.metodo_pago, usoCfdi: i.uso_cfdi, notes: i.notes, global: i.global,
        items: i.items.map((v) => ({ quantity: v.quantity, product: { description: v.description, product_key: v.product_key, unit_key: v.unit_key, price: v.unit_price, tax_included: false, taxes: v.taxes } })),
      });
      const result = await crearPrefactura(payload, { id: userId }, new Request("https://contabilidad.invalid/api/ai/documentos"));
      const body = result.body as { id?: string; error?: string };
      if (result.status !== 201 || !body.id) throw new Error(body.error ?? "No se pudo crear la prefactura.");
      ref = { kind: "prefactura", companyId, id: body.id };
    } else {
      const i = preparePayrollSchema.parse(input);
      const employees = await prisma.employee.count({ where: { companyId, id: { in: i.employee_ids }, isActive: true } });
      if (employees !== i.employee_ids.length) throw new Error("Uno o más empleados no están activos o no pertenecen a esta empresa.");
      const existing = await prisma.payrollRun.findFirst({ where: { companyId, tipo: "ORDINARIA", periodo: `${i.periodo_inicio}/${i.periodo_fin}`, items: { some: { employeeId: { in: i.employee_ids } } } }, select: { id: true } });
      if (existing) throw new Error(`Ya existe una nómina de ese periodo para empleados seleccionados (${existing.id}). Recupérala con mostrar_documento para revisar; no se creó otra.`);
      const result = await createPayrollRun({ companyId, tipo: "ORDINARIA", periodoInicio: new Date(i.periodo_inicio + "T12:00:00Z"), periodoFin: new Date(i.periodo_fin + "T12:00:00Z"), fechaPago: new Date(i.fecha_pago + "T12:00:00Z"), diasPagados: i.dias_pagados, employeeIds: i.employee_ids }, { preventEmployeeOverlap: true });
      if (!result.ok || !result.runId) throw new Error(result.error ?? "No se pudo calcular la nómina.");
      warnings = [result.tarifaWarning, result.salarioMinimoWarning].filter((v): v is string => !!v);
      ref = { kind: "nomina", companyId, id: result.runId };
    }
    const result = { documents: [ref], warnings, instruction: "Documento preparado, SIN TIMBRAR. La tarjeta permite revisar el documento completo y, si corresponde, confirmar su timbrado. Entrega aquí sus archivos; no los envíes a terceros." };
    await prisma.stagedAction.update({ where: { id: action.id }, data: { status: "DONE", payload: { conversationId, input, name, ...result } } });
    return result;
  } catch (e) {
    await prisma.stagedAction.update({ where: { id: action.id }, data: { status: "FAILED", error: e instanceof Error ? e.message : "Error de preparación" } });
    throw e;
  }
}
