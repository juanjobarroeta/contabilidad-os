import { prepararRep, type EmitirRepInput } from "@/lib/complementos-rep-emit";
import { createStagedAction } from "@/lib/staged-action-server";

// Escenifica la emisión de un complemento de pago (REP) en los rieles del Tier 3:
// valida y calcula la parcialidad SIN emitir, y devuelve un DEEP LINK a la pantalla
// de revisión y autorización dentro de la app. El REP se timbra solo cuando el
// usuario abre el enlace (sesión autenticada) y toca "Confirmar y emitir".

type PreviewInput = {
  invoice_id?: string;
  bank_transaction_id?: string;
  monto?: number;
  fecha_pago?: string;
  forma_pago?: string;
};

const MXN = (n: number) => n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });

export async function previewComplemento(
  raw: Record<string, unknown>,
  companyId: string,
  ctx: { conversationId?: string; userId?: string; inApp?: boolean } = {}
): Promise<string> {
  const { conversationId, userId, inApp } = ctx;
  if (!userId) {
    return JSON.stringify({ error: "No puedo identificar tu usuario para preparar el complemento." });
  }
  const input = raw as PreviewInput;
  if (!input.invoice_id) {
    return JSON.stringify({ error: "Falta el identificador de la factura (invoice_id) del pago a complementar." });
  }

  const emitInput: EmitirRepInput = {
    companyId,
    invoiceId: input.invoice_id,
    bankTransactionId: input.bank_transaction_id,
    monto: typeof input.monto === "number" ? input.monto : undefined,
    fechaPago: input.fecha_pago,
    formaPago: input.forma_pago,
  };

  const prep = await prepararRep(emitInput);
  if (!prep.ok) return JSON.stringify({ error: prep.error });
  const p = prep.preview;

  // Se FIJAN monto y fecha calculados: lo que el usuario autorice es exactamente
  // lo que se emite. El motor revalida contra el saldo actual al confirmar.
  const pinnedInput: EmitirRepInput = { ...emitInput, monto: p.monto, fechaPago: p.fechaPago };

  const { url } = await createStagedAction({
    type: "complemento_pago",
    companyId,
    createdByUserId: userId,
    whatsappConversationId: inApp ? null : conversationId ?? null,
    summary: `Emitir complemento de pago (parcialidad ${p.numParcialidad}) de ${p.cliente} por ${MXN(p.monto)}.`,
    payload: {
      emitInput: pinnedInput,
      resumen: {
        cliente: p.cliente,
        rfc: p.rfc,
        parentUuid: p.parentUuid,
        monto: p.monto,
        fechaPago: p.fechaPago,
        numParcialidad: p.numParcialidad,
        impSaldoAnterior: p.impSaldoAnterior,
        impSaldoInsoluto: p.impSaldoInsoluto,
        ivaTrasladado: p.ivaTrasladado,
      },
    },
  });

  const preview =
    `*Complemento de pago (REP) — aún NO emitido*\n` +
    `Cliente: ${p.cliente} (${p.rfc})\n` +
    `Pago: ${MXN(p.monto)} · ${p.fechaPago}\n` +
    `Parcialidad ${p.numParcialidad} · Saldo anterior ${MXN(p.impSaldoAnterior)} → resta ${MXN(p.impSaldoInsoluto)}`;

  return JSON.stringify({
    staged: true,
    preview,
    autorizar_url: url,
    instruccion_para_el_asistente:
      `Muestra el resumen y comparte el ENLACE DE AUTORIZACIÓN (${url}) para que el usuario revise y emita el ` +
      `complemento DENTRO de la app (requiere iniciar sesión, por seguridad; el enlace vence en 30 minutos). ` +
      `NUNCA digas que ya se emitió — se emite solo cuando el usuario autoriza; te avisaré aquí el folio fiscal cuando quede.`,
  });
}
