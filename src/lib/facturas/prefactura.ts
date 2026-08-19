import { z } from "zod";
import { signDraftToken, publicBaseUrl, TTL_CLIENTE_MS } from "@/lib/facturas/file-token";
import type { StampInput } from "@/lib/facturas/stamp";

// ─────────────────────────────────────────────────────────────────────────────
// Lo COMPARTIDO entre crear una prefactura (POST /api/facturas/borradores) y
// editarla (PUT /api/facturas/borradores/[id]): el esquema del payload, el
// total estimado y el enlace firmado del PDF.
//
// Vive en lib y no en la ruta porque editar es "volver a crear con otro
// payload": si la validación o el total divergieran entre ambos caminos, una
// prefactura editada podría guardar algo que la creación habría rechazado — y
// el total mostrado cambiaría según por cuál puerta entró.
// ─────────────────────────────────────────────────────────────────────────────

export const itemSchema = z.object({
  quantity: z.number().positive(),
  product: z.object({
    description: z.string(),
    product_key: z.string(),
    price: z.number().positive(),
    unit_key: z.string().default("E48"),
    tax_included: z.boolean().default(false),
    taxes: z
      .array(
        z.object({
          type: z.string(),
          rate: z.number(),
          factor: z.string(),
          withholding: z.boolean().default(false),
        })
      )
      .optional(),
    // Retenciones locales (complemento implocal): el 5 al millar de obra
    // pública, por ejemplo. La prefactura NO las aceptaba, así que guardar el
    // borrador las tiraba en silencio y al timbrarlo salía sin retención — con
    // un total distinto al que el cliente ya había visto en el PDF.
    local_taxes: z
      .array(
        z.object({
          type: z.string(),
          rate: z.number(),
          withholding: z.boolean().default(false),
          base: z.number().optional(),
        })
      )
      .optional(),
  }),
});

export const prefacturaSchema = z.object({
  companyId: z.string().min(1),
  customerId: z.string().min(1),
  formaPago: z.string().min(1),
  metodoPago: z.enum(["PUE", "PPD"]),
  usoCfdi: z.string().min(1),
  items: z.array(itemSchema).min(1),
  notes: z.string().optional(),
  global: z
    .object({
      periodicity: z.enum(["day", "week", "fortnight", "month", "two_months"]),
      months: z.string(),
      year: z.number(),
    })
    .optional(),
});

/**
 * Total estimado con IVA por partida (el definitivo lo fija el CFDI).
 * Las retenciones locales RESTAN y llevan su propia base cuando van
 * consolidadas en una partida (el 5 al millar se calcula sobre el subtotal
 * del comprobante, no sobre el importe de esa partida).
 */
export function totalEstimadoPrefactura(items: StampInput["items"]): string {
  return items
    .reduce((s, it) => {
      const base = it.quantity * it.product.price;
      const iva = (it.product.taxes ?? []).reduce(
        (t, tax) => t + (tax.withholding ? -1 : 1) * base * tax.rate,
        0
      );
      const local = (it.product.local_taxes ?? []).reduce(
        (t, tax) => t + (tax.withholding ? -1 : 1) * (tax.base ?? base) * tax.rate,
        0
      );
      return s + base + iva + local;
    }, 0)
    .toFixed(2);
}

/** Enlace firmado del PDF BORRADOR, apto para compartir con el cliente (7 días). */
export function pdfUrlCliente(companyId: string, draftId: string): string {
  const token = signDraftToken(companyId, draftId, TTL_CLIENTE_MS);
  return `${publicBaseUrl()}/api/facturas/draft/${draftId}/pdf?companyId=${companyId}&token=${token}`;
}
