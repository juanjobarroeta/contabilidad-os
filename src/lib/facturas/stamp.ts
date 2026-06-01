import { prisma } from "@/lib/prisma";
import { getFacturapiClient } from "@/lib/facturapi";
import { parseFacturapiError } from "@/lib/facturapi-errors";

// ─────────────────────────────────────────────────────────────────────────────
// Stamp (timbrar) a CFDI via Facturapi. Extracted from POST /api/facturas so it
// can be reused by the WhatsApp confirm-then-stamp flow. Pure of auth — the
// caller MUST authorize access to companyId first.
//
// IMPORTANT: this performs a real, billable, legally-binding fiscal action.
// Callers (especially the WhatsApp path) must gate it behind explicit
// confirmation — never auto-stamp.
// ─────────────────────────────────────────────────────────────────────────────

export interface StampItem {
  quantity: number;
  product: {
    description: string;
    product_key: string;
    price: number;
    unit_key?: string;
    tax_included?: boolean;
    taxes?: Array<{ type: string; rate: number; factor: string; withholding?: boolean }>;
  };
}

export interface StampInput {
  companyId: string;
  customerId: string;
  formaPago: string;
  metodoPago: "PUE" | "PPD";
  usoCfdi: string;
  items: StampItem[];
  notes?: string;
  global?: { periodicity: "day" | "week" | "fortnight" | "month" | "two_months"; months: string; year: number };
}

export type StampResult =
  | { ok: true; invoiceId: string; uuid: string; total: number; folio?: string | null }
  | { ok: false; status: number; error: string; needsReconfigure?: boolean };

/** Readiness: can this company stamp, and is the customer synced? */
export async function checkStampReadiness(companyId: string, customerId: string): Promise<StampResult | null> {
  const [company, customer] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { facturapiApiKey: true } }),
    prisma.customer.findUnique({ where: { id: customerId }, select: { facturapiId: true, companyId: true } }),
  ]);
  if (!company?.facturapiApiKey) {
    return { ok: false, status: 422, error: "La empresa no está lista para timbrar: configura Facturapi (CSD + Carta Manifiesto) en la app.", needsReconfigure: true };
  }
  if (!customer || customer.companyId !== companyId) {
    return { ok: false, status: 404, error: "Cliente no encontrado." };
  }
  if (!customer.facturapiId) {
    return { ok: false, status: 422, error: "El cliente no está sincronizado con Facturapi. Créalo/edítalo en la app primero." };
  }
  return null; // ready
}

export async function stampInvoice(input: StampInput): Promise<StampResult> {
  const { companyId, customerId, formaPago, metodoPago, usoCfdi, items, notes, global: globalInfo } = input;

  const notReady = await checkStampReadiness(companyId, customerId);
  if (notReady) return notReady;

  const [company, customer] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { facturapiApiKey: true } }),
    prisma.customer.findUnique({ where: { id: customerId }, select: { facturapiId: true, rfc: true } }),
  ]);

  const facturapi = getFacturapiClient(company!.facturapiApiKey!);

  // CFDI 4.0: Información Global mandatory for Público General.
  let resolvedGlobal = globalInfo;
  if (customer!.rfc === "XAXX010101000" && !resolvedGlobal) {
    const now = new Date();
    resolvedGlobal = { periodicity: "month", months: String(now.getMonth() + 1).padStart(2, "0"), year: now.getFullYear() };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fp: any;
  try {
    fp = await facturapi.invoices.create({
      customer: customer!.facturapiId!,
      payment_form: formaPago,
      payment_method: metodoPago,
      use: usoCfdi,
      items: items.map((it) => ({ quantity: it.quantity, product: it.product })),
      ...(notes && { pdf_custom_section: notes }),
      ...(resolvedGlobal && { global: resolvedGlobal }),
    });
  } catch (e) {
    const info = parseFacturapiError(e);
    return { ok: false, status: info.status, error: info.message, needsReconfigure: info.needsReconfigure };
  }

  const computedSubtotal = items.reduce((s, it) => s + it.quantity * it.product.price, 0);
  const total = fp.total ?? computedSubtotal;
  const subtotal = typeof fp.subtotal === "number" && fp.subtotal > 0.01 ? fp.subtotal : computedSubtotal;
  const totalImpuestos = +(total - subtotal).toFixed(2);

  const invoice = await prisma.invoice.create({
    data: {
      companyId,
      customerId,
      tipo: "INGRESO",
      fecha: new Date(),
      formaPago,
      metodoPago,
      usoCfdi,
      subtotal,
      total,
      totalImpuestos,
      notas: notes,
      status: "STAMPED",
      uuid: fp.uuid,
      facturapiId: fp.id,
      items: {
        create: items.map((it) => ({
          cantidad: it.quantity,
          claveUnidad: it.product.unit_key ?? "E48",
          claveProdServ: it.product.product_key,
          descripcion: it.product.description,
          valorUnitario: it.product.price,
          importe: it.quantity * it.product.price,
        })),
      },
    },
  });

  return { ok: true, invoiceId: invoice.id, uuid: fp.uuid, total, folio: fp.folio_number ?? null };
}
