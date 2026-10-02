import { z } from "zod";

export const DOCUMENT_KINDS = ["balanza", "polizas", "catalogo", "iva", "isr", "retenciones", "factura", "prefactura", "nomina", "recibo_nomina"] as const;
export const documentRefSchema = z.object({
  kind: z.enum(DOCUMENT_KINDS),
  companyId: z.string().min(1).max(100),
  id: z.string().min(1).max(100).optional(),
  year: z.number().int().min(2000).max(2100).optional(),
  month: z.number().int().min(1).max(12).optional(),
}).strict().superRefine((r, ctx) => {
  const record = ["factura", "prefactura", "nomina", "recibo_nomina"].includes(r.kind);
  if (record && !r.id) ctx.addIssue({ code: "custom", message: "Documento requerido" });
  if (!record && r.kind !== "catalogo" && (!r.year || !r.month))
    ctx.addIssue({ code: "custom", message: "Periodo requerido" });
});
export type DocumentRef = z.infer<typeof documentRefSchema>;
export type DocumentCard = { type: "documentos"; documents: DocumentRef[] };
export const documentTitles: Record<DocumentRef["kind"], string> = {
  balanza: "Balanza de comprobación", polizas: "Pólizas y libro diario", catalogo: "Catálogo de cuentas",
  iva: "Papel de IVA", isr: "Papel de ISR", retenciones: "Papel de retenciones",
  factura: "CFDI", prefactura: "Prefactura", nomina: "Nómina", recibo_nomina: "Recibo de nómina",
};
export const DOCUMENT_TOOL_NAMES = new Set(["buscar_documentos", "mostrar_documento", "preparar_prefactura", "preparar_nomina"]);
export const DOCUMENT_PREPARE_NAMES = new Set(["preparar_prefactura", "preparar_nomina"]);

/** Cards carry references only. Titles, amounts, status and links come from an
 * authenticated read, never from model-authored presentation arguments. */
export function documentCardFromResult(name: string, result: string): DocumentCard | null {
  if (!DOCUMENT_TOOL_NAMES.has(name)) return null;
  try {
    const body = JSON.parse(result);
    const parsed = z.array(documentRefSchema).min(1).max(10).safeParse(body.documents);
    return parsed.success ? { type: "documentos", documents: parsed.data } : null;
  } catch { return null; }
}

export type DocumentView = {
  ref: DocumentRef;
  company: { id: string; razonSocial: string; rfc: string };
  title: string;
  status: string;
  source: string;
  updatedAt: string;
  total?: number;
  currency?: string;
  uuid?: string | null;
  recipient?: string;
  period?: string;
  paymentDate?: string;
  downloads: { label: string; href: string }[];
  invoiceId?: string;
  previewUrl?: string;
  draftPayload?: Record<string, unknown>;
  receipts?: { id: string; employee: string; rfc: string; perceptions: number; deductions: number; net: number; uuid: string | null }[];
  stampable: boolean;
};

export type StampReview = { token: string; amountToStamp: number; view: DocumentView; payloads: { id: string; payload: Record<string, unknown> }[] };
