import { prisma } from "@/lib/prisma";
import { checkStampReadiness, type StampInput, type StampItem } from "@/lib/facturas/stamp";
import { stagePendingTimbrar } from "@/lib/whatsapp/pending-action";

// Builds a CFDI preview from a natural-language-ish tool input, validates
// readiness, and stages it as a pending action requiring a confirmation code.
// Does NOT stamp — that only happens when the user replies with the code.

type PreviewInput = {
  customer_id?: string;
  customer_rfc?: string;
  customer_name?: string;
  forma_pago?: string;
  metodo_pago?: string;
  uso_cfdi?: string;
  items?: Array<{
    description?: string;
    product_key?: string;
    quantity?: number;
    unit_price?: number;
    iva_rate?: number; // default 0.16
  }>;
  notes?: string;
};

const MXN = (n: number) => n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });

export async function previewTimbrar(
  raw: Record<string, unknown>,
  companyId: string,
  conversationId?: string
): Promise<string> {
  if (!conversationId) {
    return JSON.stringify({ error: "Timbrar solo está disponible por WhatsApp con confirmación." });
  }
  const input = raw as PreviewInput;

  // ── Resolve customer ──────────────────────────────────────────────────────
  let customer = null as { id: string; rfc: string; razonSocial: string; facturapiId: string | null } | null;
  if (input.customer_id) {
    customer = await prisma.customer.findFirst({
      where: { id: input.customer_id, companyId },
      select: { id: true, rfc: true, razonSocial: true, facturapiId: true },
    });
  } else if (input.customer_rfc || input.customer_name) {
    customer = await prisma.customer.findFirst({
      where: {
        companyId,
        ...(input.customer_rfc
          ? { rfc: input.customer_rfc.toUpperCase() }
          : { razonSocial: { contains: input.customer_name!, mode: "insensitive" } }),
      },
      select: { id: true, rfc: true, razonSocial: true, facturapiId: true },
    });
  }
  if (!customer) {
    return JSON.stringify({
      error: "No encontré ese cliente. Pide al usuario el RFC exacto o que lo dé de alta en la app.",
    });
  }

  // ── Validate items ────────────────────────────────────────────────────────
  if (!input.items?.length) {
    return JSON.stringify({ error: "Faltan los conceptos (descripción, cantidad, precio) para la factura." });
  }
  const items: StampItem[] = [];
  for (const it of input.items) {
    if (!it.description || typeof it.unit_price !== "number") {
      return JSON.stringify({ error: "Cada concepto necesita descripción y precio unitario." });
    }
    const rate = typeof it.iva_rate === "number" ? it.iva_rate : 0.16;
    items.push({
      quantity: it.quantity ?? 1,
      product: {
        description: it.description,
        product_key: it.product_key ?? "01010101", // genérico; idealmente el usuario lo da
        price: it.unit_price,
        // CRITICAL: our preview treats unit_price as the BASE (subtotal + IVA).
        // Facturapi defaults tax_included=true (price = total, backs out base),
        // which would stamp different numbers than the user confirmed. Force
        // tax_included=false so the stamp matches the preview exactly.
        tax_included: false,
        taxes: rate > 0 ? [{ type: "IVA", rate, factor: "Tasa" }] : [],
      },
    });
  }

  const payload: StampInput = {
    companyId,
    customerId: customer.id,
    formaPago: input.forma_pago ?? "99",
    metodoPago: input.metodo_pago === "PPD" ? "PPD" : "PUE",
    usoCfdi: input.uso_cfdi ?? "G03",
    items,
    notes: input.notes,
  };

  // ── Readiness check before we even preview ────────────────────────────────
  const notReady = await checkStampReadiness(companyId, customer.id);
  if (notReady && !notReady.ok) return JSON.stringify({ error: notReady.error });

  // ── Build preview + totals ────────────────────────────────────────────────
  const subtotal = items.reduce((s, it) => s + it.quantity * it.product.price, 0);
  const iva = items.reduce(
    (s, it) => s + it.quantity * it.product.price * (it.product.taxes?.[0]?.rate ?? 0),
    0
  );
  const total = subtotal + iva;
  const lines = items
    .map((it) => `• ${it.quantity} x ${it.product.description} @ ${MXN(it.product.price)}`)
    .join("\n");
  const preview =
    `Cliente: ${customer.razonSocial} (${customer.rfc})\n` +
    `${lines}\n` +
    `Subtotal: ${MXN(subtotal)}\nIVA: ${MXN(iva)}\n*Total: ${MXN(total)}*\n` +
    `Método: ${payload.metodoPago} · Uso: ${payload.usoCfdi}`;

  const { code } = await stagePendingTimbrar(conversationId, companyId, payload, preview);

  // The model relays this to the user. It must NOT claim it already stamped.
  return JSON.stringify({
    staged: true,
    preview,
    instruccion_para_el_asistente:
      `Muestra este resumen al usuario y pídele que confirme respondiendo con el código ${code} para timbrar, ` +
      `o 'cancelar'. NO digas que ya se timbró — aún NO se ha timbrado. El timbrado ocurre solo cuando el usuario envía el código.`,
    codigo_confirmacion: code,
  });
}
