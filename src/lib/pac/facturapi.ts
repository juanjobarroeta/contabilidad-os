// ─────────────────────────────────────────────────────────────────────────────
// FacturapiPacProvider — implementación de PacProvider sobre Facturapi.
//
// Encapsula TODAS las llamadas de timbrado al SDK de Facturapi y traduce sus
// errores al envelope neutral (PacOutcome) con parseFacturapiError. El resto de
// la app no debe importar `facturapi` directamente para emitir/cancelar: usa
// getPacProvider() de "@/lib/pac".
// ─────────────────────────────────────────────────────────────────────────────

import { getFacturapiClient, provisionFacturapiOrg } from "../facturapi";
import { parseFacturapiError } from "../facturapi-errors";
import type {
  CfdiInput,
  OrgProvisionResult,
  PacOutcome,
  PacProvider,
  StampedCfdi,
} from "./types";

// Mapea las líneas neutrales al shape que espera Facturapi (es casi 1:1: el
// `product` ya viene en claves SAT).
function mapItems(input: CfdiInput) {
  return input.items.map((it) => ({ quantity: it.quantity, product: it.product }));
}

// Cuerpo común de invoices.create para timbre directo y borrador.
function buildInvoiceBody(input: CfdiInput) {
  return {
    customer: input.customerRef,
    payment_form: input.paymentForm,
    payment_method: input.paymentMethod,
    use: input.use,
    items: mapItems(input),
    ...(input.notes ? { pdf_custom_section: input.notes } : {}),
    ...(input.global ? { global: input.global } : {}),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toStamped(fp: any): StampedCfdi {
  return {
    pacId: fp.id,
    uuid: fp.uuid ?? null,
    total: typeof fp.total === "number" ? fp.total : undefined,
    subtotal: typeof fp.subtotal === "number" ? fp.subtotal : undefined,
    folio: fp.folio_number ?? null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fail(e: any): Extract<PacOutcome<never>, { ok: false }> {
  const info = parseFacturapiError(e);
  return {
    ok: false,
    status: info.status,
    message: info.message,
    kind: info.kind,
    needsReconfigure: info.needsReconfigure,
  };
}

export const facturapiPacProvider: PacProvider = {
  name: "facturapi",

  async createCfdi(apiKey, input): Promise<PacOutcome<StampedCfdi>> {
    try {
      const fp = await getFacturapiClient(apiKey).invoices.create(buildInvoiceBody(input));
      return { ok: true, data: toStamped(fp) };
    } catch (e) {
      return fail(e);
    }
  },

  async createDraft(apiKey, input): Promise<PacOutcome<{ draftId: string }>> {
    try {
      const fp = await getFacturapiClient(apiKey).invoices.create({
        ...buildInvoiceBody(input),
        status: "draft",
      });
      return { ok: true, data: { draftId: fp.id } };
    } catch (e) {
      return fail(e);
    }
  },

  async stampDraft(apiKey, draftId): Promise<PacOutcome<StampedCfdi>> {
    try {
      const fp = await getFacturapiClient(apiKey).invoices.stampDraft(draftId);
      return { ok: true, data: toStamped(fp) };
    } catch (e) {
      return fail(e);
    }
  },

  async discardDraft(apiKey, draftId): Promise<void> {
    try {
      await getFacturapiClient(apiKey).invoices.cancel(draftId);
    } catch (e) {
      console.error("[pac:facturapi] discardDraft falló", e);
    }
  },

  async cancelCfdi(apiKey, pacId, motivo, sustituyeUuid): Promise<PacOutcome<void>> {
    try {
      // Facturapi params: { motive, substitution? }.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (getFacturapiClient(apiKey) as any).invoices.cancel(pacId, {
        motive: motivo,
        ...(sustituyeUuid ? { substitution: sustituyeUuid } : {}),
      });
      return { ok: true, data: undefined };
    } catch (e) {
      return fail(e);
    }
  },

  provisionOrg(companyId): Promise<OrgProvisionResult> {
    return provisionFacturapiOrg(companyId);
  },
};
