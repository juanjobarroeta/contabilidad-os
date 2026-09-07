// ─────────────────────────────────────────────────────────────────────────────
// SOLICITAR una cancelación no es CANCELAR. Puro.
//
// Juan, viendo el portal del SAT junto a nuestra pantalla: «creo que no
// distinguimos entre facturas con cancelación solicitada y facturas realmente
// aceptadas». Tenía razón, y el portal lo decía en tres columnas distintas:
//
//   Estatus de cancelación ......... «Cancelable con aceptación»
//   Estado del Comprobante ......... «Vigente»          ← el que manda
//   Estatus de Proceso de Cancelación  «En proceso»
//
// Desde la reforma de 2022 al CFF, un CFDI de más de $1,000 a un tercero sólo
// se cancela CON ACEPTACIÓN del receptor: el SAT abre el proceso y el
// comprobante SIGUE VIGENTE —causando IVA y acumulando ingreso— hasta que el
// receptor acepta, o pasan 72 h sin que conteste (aceptación tácita). Si el
// receptor RECHAZA, el comprobante se queda vigente para siempre.
//
// El que decide es «Estado del Comprobante». Todo lo demás describe el trámite.
// ─────────────────────────────────────────────────────────────────────────────

/** Qué le pasó de verdad al comprobante, según el SAT. */
export type EstadoCancelacion =
  /** El SAT ya no lo reconoce: sale de IVA e ISR. */
  | "cancelado"
  /** Solicitado y sin resolver: SIGUE VIGENTE y sigue contando. */
  | "en_proceso"
  /** Vigente y sin proceso abierto (nunca se pidió, o se rechazó / venció). */
  | "vigente"
  /** El SAT no dijo lo suficiente. Se trata como vigente: no se borra nada. */
  | "desconocido";

/**
 * ¿El texto describe un comprobante ya cancelado?
 *
 * Cuidado con «cancelaBLE»: «Cancelable con aceptación» significa justo lo
 * contrario —que TODAVÍA se puede pedir la cancelación— y un `startsWith
 * ("cancel")` lo daba por cancelado. Ese prefijo era una mina.
 */
export function diceCancelado(texto: string | null | undefined): boolean {
  const v = (texto ?? "").trim().toLowerCase();
  if (v === "") return false;
  if (v.startsWith("cancelable")) return false; // se PUEDE cancelar ≠ cancelado
  return v === "0" || v.startsWith("cancelado") || v.startsWith("cancelada");
}

/** ¿El texto describe un trámite abierto y sin resolver? */
export function diceEnProceso(texto: string | null | undefined): boolean {
  const v = (texto ?? "").trim().toLowerCase();
  return v.includes("en proceso") || v.includes("en proces");
}

/**
 * Lee la consulta pública del SAT (Estado + EstatusCancelacion) y dice qué es.
 * `estado` manda: mientras diga «Vigente», el comprobante cuenta, se haya
 * pedido lo que se haya pedido.
 */
export function estadoDeCancelacion(sat: {
  estado: string | null | undefined;
  estatusCancelacion?: string | null;
}): EstadoCancelacion {
  const estado = (sat.estado ?? "").trim().toLowerCase();
  if (estado === "") return "desconocido";
  if (diceCancelado(estado)) return "cancelado";
  if (estado.startsWith("vigente")) {
    return diceEnProceso(sat.estatusCancelacion) ? "en_proceso" : "vigente";
  }
  // "No Encontrado" y cualquier otra cosa: no afirmamos nada.
  return "desconocido";
}

/**
 * ¿Lo que tenemos guardado contradice al SAT?
 *
 * El caso que duele: la tenemos CANCELLED y el SAT la reporta VIGENTE. El mes
 * pierde ese ingreso y su IVA sin que nadie lo sepa. No se repara solo —
 * cancelar revierte unidades, costos y kardex, y restaurar el estatus no
 * deshace eso— pero SÍ se dice, fuerte y donde se ve.
 */
export function contradiceAlSat(
  nuestro: { status: string },
  sat: EstadoCancelacion,
): boolean {
  return nuestro.status === "CANCELLED" && (sat === "vigente" || sat === "en_proceso");
}
