import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireContaBotAccess } from "@/lib/contabot/access";
import type { ToolContext } from "../tool-executor";
import { documentRefSchema, DOCUMENT_PREPARE_NAMES, type DocumentRef } from "./contract";
import { readDocument } from "./read";
import { fiscalDay, prepareDocument } from "./prepare";

const searchSchema = z.object({ kind: z.enum(["factura", "prefactura", "nomina", "recibo_nomina"]), q: z.string().trim().max(200).optional(), date_from: fiscalDay.optional(), date_to: fiscalDay.optional(), cursor: z.number().int().min(0).max(10000).default(0) }).strict();
export async function executeDocumentTool(name: string, input: Record<string, unknown>, companyId: string, context: ToolContext) {
  try {
    if (!context.userId) throw new Error("Se requiere una sesión autorizada.");
    const access = await requireContaBotAccess(context.userId, companyId, context.conversationId, { requireEnabled: false });
    if (DOCUMENT_PREPARE_NAMES.has(name)) {
      if (!access.canWrite || !context.inApp || !context.conversationId) throw new Error("La preparación requiere permiso de escritura y una conversación en la app.");
      return JSON.stringify(await prepareDocument(name, input, companyId, context.userId, context.conversationId, context.userMessageId));
    }
    if (name === "mostrar_documento") {
      if ("companyId" in input) throw new Error("La empresa la determina la conversación.");
      const ref = documentRefSchema.parse({ ...input, companyId });
      const view = await readDocument(ref);
      return JSON.stringify({ documents: [ref], title: view.title, company: view.company, status: view.status, period: view.period, total: view.total, currency: view.currency, source: view.source, instruction: "La tarjeta entrega el documento real con vista y archivos. No implica revisión, timbrado ni envío a terceros." });
    }
    if (name !== "buscar_documentos") throw new Error("Herramienta no disponible.");
    const q = searchSchema.parse(input);
    if (q.date_from && q.date_to && q.date_from > q.date_to) throw new Error("Rango de fechas inválido.");
    const date = { ...(q.date_from ? { gte: new Date(q.date_from + "T00:00:00Z") } : {}), ...(q.date_to ? { lte: new Date(q.date_to + "T23:59:59.999Z") } : {}) };
    const hasDate = q.date_from || q.date_to;
    const text = q.q ? { contains: q.q, mode: "insensitive" as const } : undefined;
    const paging = { take: 11, skip: q.cursor };
    let rows: { id: string; label: string; status: string; total: number; currency?: string }[];
    if (q.kind === "factura") {
      const found = await prisma.invoice.findMany({ where: { companyId, ...(hasDate ? { fecha: date } : {}), ...(text ? { OR: [{ uuid: text }, { folio: text }, { customer: { razonSocial: text } }, { customer: { rfc: text } }, { contraparteNombre: text }, { contraparteRfc: text }] } : {}) }, orderBy: [{ fecha: "desc" }, { id: "asc" }], ...paging, select: { id: true, uuid: true, folio: true, status: true, total: true, moneda: true } });
      rows = found.map((i) => ({ id: i.id, label: i.uuid ?? i.folio ?? i.id, status: i.status, total: Number(i.total), currency: i.moneda }));
    } else if (q.kind === "prefactura") {
      const found = await prisma.facturaBorrador.findMany({ where: { companyId, ...(hasDate ? { createdAt: date } : {}), ...(text ? { customer: { OR: [{ razonSocial: text }, { rfc: text }] } } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], ...paging, include: { customer: { select: { razonSocial: true } } } });
      rows = found.map((i) => ({ id: i.id, label: i.customer.razonSocial, status: i.status, total: Number(i.total) }));
    } else if (q.kind === "nomina") {
      const found = await prisma.payrollRun.findMany({ where: { companyId, ...(hasDate ? { fechaPago: date } : {}), ...(text ? { periodo: text } : {}) }, orderBy: [{ fechaPago: "desc" }, { id: "asc" }], ...paging });
      rows = found.map((i) => ({ id: i.id, label: i.periodo, status: i.status, total: Number(i.totalNeto) }));
    } else {
      const found = await prisma.payrollItem.findMany({ where: { payrollRun: { companyId, ...(hasDate ? { fechaPago: date } : {}) }, employee: { companyId }, ...(text ? { OR: [{ cfdiUuid: text }, { employee: { nombre: text } }, { employee: { apellidoPaterno: text } }, { employee: { rfc: text } }] } : {}) }, orderBy: [{ payrollRun: { fechaPago: "desc" } }, { id: "asc" }], ...paging, include: { employee: { select: { nombre: true, apellidoPaterno: true } } } });
      rows = found.map((i) => ({ id: i.id, label: `${i.employee.nombre} ${i.employee.apellidoPaterno}`, status: i.cfdiUuid ? "TIMBRADO" : "BORRADOR", total: Number(i.netoAPagar) }));
    }
    return JSON.stringify({ documents: rows.slice(0, 10).map((r): DocumentRef => ({ kind: q.kind, id: r.id, companyId })), results: rows.slice(0, 10).map((r) => ({ ...r, currency: r.currency ?? "MXN" })), next_cursor: rows.length > 10 ? q.cursor + 10 : null, instruction: "Los documentos existentes se recuperan, nunca se vuelven a timbrar. Usa next_cursor si faltan resultados. Para recibos históricos sin corrida, busca también kind=factura por RFC/nombre/UUID: incluye CFDI de nómina importados." });
  } catch (e) {
    return JSON.stringify({ error: e instanceof z.ZodError ? e.issues.map((i) => i.message).join("; ") : e instanceof Error && !/prisma|Invalid.*invocation|SELECT |api.key|sk_live/i.test(e.message) ? e.message : "No se pudo verificar el documento. Consulta el estado antes de repetir una preparación." });
  }
}
