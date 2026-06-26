import { prisma } from "@/lib/prisma";
import { getPacProvider, type CfdiInput, type StampedCfdi } from "@/lib/pac";
import { recordTimbrado } from "@/lib/costos/record";

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

/**
 * CFDI 4.0 requires Información Global for Público General (RFC genérico).
 * Auto-fills the current month when the caller didn't pass one.
 */
function resolveGlobalInfo(rfc: string, globalInfo: StampInput["global"]): StampInput["global"] {
  if (rfc === "XAXX010101000" && !globalInfo) {
    const now = new Date();
    return { periodicity: "month", months: String(now.getMonth() + 1).padStart(2, "0"), year: now.getFullYear() };
  }
  return globalInfo;
}

/** Maps the local StampInput to the provider-neutral CfdiInput. */
function toCfdiInput(
  input: StampInput,
  customerRef: string,
  customer: { rfc: string; razonSocial: string; regimenFiscal: string; codigoPostal: string | null },
): CfdiInput {
  return {
    customerRef,
    // Receptor en línea para PACs sin catálogo (SW). Facturapi lo ignora.
    receptor: {
      rfc: customer.rfc,
      nombre: customer.razonSocial,
      regimenFiscal: customer.regimenFiscal,
      domicilioFiscalCP: customer.codigoPostal ?? "",
    },
    paymentForm: input.formaPago,
    paymentMethod: input.metodoPago,
    use: input.usoCfdi,
    items: input.items,
    notes: input.notes,
    global: resolveGlobalInfo(customer.rfc, input.global),
  };
}

/** Persists a stamped CFDI as a local INGRESO Invoice + line items. */
async function persistStampedInvoice(
  input: StampInput,
  stamped: StampedCfdi
): Promise<StampResult> {
  const { companyId, customerId, formaPago, metodoPago, usoCfdi, items, notes } = input;
  const computedSubtotal = items.reduce((s, it) => s + it.quantity * it.product.price, 0);
  const total = stamped.total ?? computedSubtotal;
  const subtotal = typeof stamped.subtotal === "number" && stamped.subtotal > 0.01 ? stamped.subtotal : computedSubtotal;
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
      // Canonizar a MAYÚSCULAS: Facturapi puede devolver el UUID en minúsculas
      // y la descarga del SAT lo trae en mayúsculas — guardarlos distinto
      // duplica el CFDI y rompe el empate de cancelaciones.
      uuid: stamped.uuid?.toUpperCase() ?? null,
      facturapiId: stamped.pacId,
      items: {
        create: items.map((it) => ({
          cantidad: it.quantity,
          // unit_key is always set by callers now, so the DB record matches the
          // stamped CFDI (the old `?? "E48"` could diverge from Facturapi's H87).
          claveUnidad: it.product.unit_key ?? "E48",
          claveProdServ: it.product.product_key,
          descripcion: it.product.description,
          valorUnitario: it.product.price,
          importe: it.quantity * it.product.price,
        })),
      },
    },
  });

  // Costo del timbre (fire-and-forget). Chokepoint común de stampInvoice y
  // stampDraftFromPending — cada uno consume un timbre al persistir.
  void recordTimbrado("factura", 1, { companyId: input.companyId, subtipo: "facturas.stamp" });

  return { ok: true, invoiceId: invoice.id, uuid: stamped.uuid ?? "", total, folio: stamped.folio != null ? String(stamped.folio) : null };
}

export async function stampInvoice(input: StampInput): Promise<StampResult> {
  const { companyId, customerId } = input;

  const notReady = await checkStampReadiness(companyId, customerId);
  if (notReady) return notReady;

  const [company, customer] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { facturapiApiKey: true } }),
    prisma.customer.findUnique({
      where: { id: customerId },
      select: { facturapiId: true, rfc: true, razonSocial: true, regimenFiscal: true, codigoPostal: true },
    }),
  ]);

  const cfdi = toCfdiInput(input, customer!.facturapiId!, customer!);
  const out = await getPacProvider().createCfdi(company!.facturapiApiKey!, cfdi);
  if (!out.ok) {
    return { ok: false, status: out.status, error: out.message, needsReconfigure: out.needsReconfigure };
  }

  return persistStampedInvoice(input, out.data);
}

// ─────────────────────────────────────────────────────────────────────────────
// Prefactura (borrador) flow — used by WhatsApp confirm-then-stamp.
//
// 1. createDraftInvoice → Facturapi draft (status:"draft"). No timbre consumed,
//    no local Invoice yet. Its PDF renders as BORRADOR so the user can validate
//    the SAT classification (clave producto/servicio + unidad) BEFORE stamping.
// 2. stampDraftFromPending → promotes that exact draft to a stamped CFDI on the
//    user's confirmation code, then persists the local Invoice.
// ─────────────────────────────────────────────────────────────────────────────

export type DraftResult =
  | { ok: true; draftId: string }
  | { ok: false; status: number; error: string; needsReconfigure?: boolean };

export async function createDraftInvoice(input: StampInput): Promise<DraftResult> {
  const { companyId, customerId } = input;

  const notReady = await checkStampReadiness(companyId, customerId);
  if (notReady && !notReady.ok) {
    return { ok: false, status: notReady.status, error: notReady.error, needsReconfigure: notReady.needsReconfigure };
  }

  const [company, customer] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { facturapiApiKey: true } }),
    prisma.customer.findUnique({
      where: { id: customerId },
      select: { facturapiId: true, rfc: true, razonSocial: true, regimenFiscal: true, codigoPostal: true },
    }),
  ]);

  const cfdi = toCfdiInput(input, customer!.facturapiId!, customer!);
  const out = await getPacProvider().createDraft(company!.facturapiApiKey!, cfdi);
  if (!out.ok) {
    return { ok: false, status: out.status, error: out.message, needsReconfigure: out.needsReconfigure };
  }
  return { ok: true, draftId: out.data.draftId };
}

export async function stampDraftFromPending(input: StampInput, draftId: string): Promise<StampResult> {
  const company = await prisma.company.findUnique({
    where: { id: input.companyId },
    select: { facturapiApiKey: true },
  });
  if (!company?.facturapiApiKey) {
    return { ok: false, status: 422, error: "La empresa ya no está lista para timbrar." };
  }

  const out = await getPacProvider().stampDraft(company.facturapiApiKey, draftId);
  if (!out.ok) {
    return { ok: false, status: out.status, error: out.message, needsReconfigure: out.needsReconfigure };
  }

  return persistStampedInvoice(input, out.data);
}

/** Best-effort delete of an unstamped draft (e.g. user cancelled). Never throws. */
export async function discardDraft(companyId: string, draftId: string): Promise<void> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { facturapiApiKey: true },
  });
  if (!company?.facturapiApiKey) return;
  await getPacProvider().discardDraft(company.facturapiApiKey, draftId);
}
