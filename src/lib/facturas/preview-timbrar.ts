import { prisma } from "@/lib/prisma";
import { createDraftInvoice, type StampInput, type StampItem } from "@/lib/facturas/stamp";
import { signDraftToken, publicBaseUrl } from "@/lib/facturas/file-token";
import { createStagedAction } from "@/lib/staged-action-server";

// Builds a CFDI PREFACTURA (Facturapi borrador) from a natural-language-ish tool
// input, validates readiness, links its PDF so the user can verify the SAT
// classification (clave producto/servicio + unidad), and STAGES it on the Tier-3
// rails: a deep link to an in-app review+confirm screen. Does NOT stamp — the
// draft is promoted to a real CFDI only when the user authorizes it inside the
// app (authenticated session = real re-authentication, not a chat "sí").

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
    unit_key?: string;
    tipo?: "servicio" | "producto";
    quantity?: number;
    unit_price?: number;
    iva_rate?: number; // default 0.16
  }>;
  notes?: string;
};

const MXN = (n: number) => n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });

// Human labels for the common SAT ClaveUnidad values we set, so the resumen
// reads "E48 Servicio" / "H87 Pieza" rather than a bare code.
const UNIDAD_LABEL: Record<string, string> = {
  E48: "Unidad de servicio",
  H87: "Pieza",
  ACT: "Actividad",
  KGM: "Kilogramo",
  LTR: "Litro",
  MTR: "Metro",
  E51: "Trabajo",
};

function unidadLabel(clave: string): string {
  const l = UNIDAD_LABEL[clave];
  return l ? `${clave} ${l}` : clave;
}

export async function previewTimbrar(
  raw: Record<string, unknown>,
  companyId: string,
  ctx: { conversationId?: string; userId?: string; inApp?: boolean } = {}
): Promise<string> {
  const { conversationId, userId, inApp } = ctx;
  if (!userId) {
    return JSON.stringify({ error: "No puedo identificar tu usuario para preparar el timbrado." });
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

  // ── Validate + build items ────────────────────────────────────────────────
  if (!input.items?.length) {
    return JSON.stringify({ error: "Faltan los conceptos (descripción, cantidad, precio) para la factura." });
  }
  const items: StampItem[] = [];
  for (const it of input.items) {
    if (!it.description || typeof it.unit_price !== "number") {
      return JSON.stringify({ error: "Cada concepto necesita descripción y precio unitario." });
    }
    const rate = typeof it.iva_rate === "number" ? it.iva_rate : 0.16;
    // ClaveUnidad: explicit wins; otherwise infer from tipo. Default to E48
    // (servicio) rather than letting Facturapi fall back to H87 "Pieza" — that
    // default is exactly what stamped a service as a physical piece before.
    const unitKey = it.unit_key ?? (it.tipo === "producto" ? "H87" : "E48");
    items.push({
      quantity: it.quantity ?? 1,
      product: {
        description: it.description,
        product_key: it.product_key ?? "01010101", // genérico; el modelo debe dar uno específico
        unit_key: unitKey,
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

  // ── Create the Facturapi draft (borrador) — validates readiness + math ─────
  const draft = await createDraftInvoice(payload);
  if (!draft.ok) return JSON.stringify({ error: draft.error });

  // ── Build preview + totals ────────────────────────────────────────────────
  const subtotal = items.reduce((s, it) => s + it.quantity * it.product.price, 0);
  const iva = items.reduce(
    (s, it) => s + it.quantity * it.product.price * (it.product.taxes?.[0]?.rate ?? 0),
    0
  );
  const total = subtotal + iva;
  const lines = items
    .map(
      (it) =>
        `• ${it.quantity} x ${it.product.description} @ ${MXN(it.product.price)}\n` +
        `   SAT: clave ${it.product.product_key} · unidad ${unidadLabel(it.product.unit_key ?? "E48")}`
    )
    .join("\n");

  // Tokenized, session-less link to the borrador PDF (30-min TTL).
  const base = publicBaseUrl();
  const pdfUrl = base
    ? `${base}/api/facturas/draft/${draft.draftId}/pdf?companyId=${companyId}&token=${signDraftToken(companyId, draft.draftId)}`
    : null;

  const preview =
    `*PREFACTURA (borrador — aún NO timbrada)*\n` +
    `Cliente: ${customer.razonSocial} (${customer.rfc})\n` +
    `${lines}\n` +
    `Subtotal: ${MXN(subtotal)}\nIVA: ${MXN(iva)}\n*Total: ${MXN(total)}*\n` +
    `Método: ${payload.metodoPago} · Uso: ${payload.usoCfdi}` +
    (pdfUrl ? `\n📄 Revisa el borrador: ${pdfUrl}` : "");

  // Tier 3: se escenifica en los rieles y se genera un DEEP LINK a la pantalla de
  // revisión dentro de la app. El timbrado NO ocurre aquí; ocurre cuando el usuario
  // abre el enlace (sesión autenticada) y toca "Confirmar y timbrar".
  const { url } = await createStagedAction({
    type: "timbrar",
    companyId,
    createdByUserId: userId,
    // Solo enlazamos la conversación de WhatsApp (para avisar el resultado por
    // ahí). En la app el usuario ve el resultado en la misma pantalla.
    whatsappConversationId: inApp ? null : conversationId ?? null,
    summary: `Timbrar factura para ${customer.razonSocial} por ${MXN(total)}.`,
    payload: {
      stampInput: payload,
      draftId: draft.draftId,
      previewText: preview,
      resumen: {
        cliente: customer.razonSocial,
        rfc: customer.rfc,
        subtotal,
        iva,
        total,
        metodoPago: payload.metodoPago,
        usoCfdi: payload.usoCfdi,
      },
    },
  });

  // The model relays this to the user. It must NOT claim it already stamped.
  return JSON.stringify({
    staged: true,
    preview,
    prefactura_pdf: pdfUrl,
    autorizar_url: url,
    instruccion_para_el_asistente:
      `Muestra este resumen al usuario y compártele el ENLACE DE AUTORIZACIÓN (${url}) para que revise y timbre ` +
      `DENTRO de la app (ahí valida la clasificación SAT y confirma con un toque; requiere iniciar sesión, por seguridad). ` +
      `El enlace vence en 30 minutos. Si la clave o la unidad están mal (p.ej. salió "Pieza" para un servicio), corrige y ` +
      `vuelve a llamar preview_factura para generar un enlace nuevo. NUNCA digas que ya se timbró — se timbra solo cuando el ` +
      `usuario autoriza en la app; te avisaré aquí el folio fiscal cuando quede.`,
  });
}
