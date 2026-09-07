// ─────────────────────────────────────────────────────────────────────────────
// ¿ESTE MES YA ESTÁ HECHO?
//
// Un mes cuya declaración ya se presentó —y del que tenemos el acuse, casi
// siempre bajado del SAT— no es trabajo pendiente: está cerrado, lo cerró el
// contribuyente ante la autoridad. Pedirle a alguien que «confirme los doce
// pasos» de julio de 2021 es inventar tarea.
//
// Se DERIVA, no se guarda: la fuente es la misma señal del checklist que ya
// mira si la declaración del periodo está presentada. Y no se estira más allá
// de lo que dice: declarado significa presentado ante el SAT, no que la
// contabilidad del mes esté impecable — si quedaron cosas sin cuadrar, se
// siguen viendo, pero como observaciones, no como pendientes que bloquean.
// ─────────────────────────────────────────────────────────────────────────────

import type { CierreEvaluado } from "./evaluar";

export interface EstadoPeriodo {
  /** La declaración del periodo está presentada ante el SAT. */
  declarado: boolean;
  /** Lo que dice la señal (con su fecha, cuando la trae). */
  detalle: string | null;
  /** El pago quedó ligado a un movimiento del banco (o la declaración está PAID). */
  pagado: boolean;
}

export function estadoDelPeriodo(cierre: CierreEvaluado): EstadoPeriodo {
  const paso = cierre.pasos.find((p) => p.clave === "declaracion");
  if (!paso || paso.estadoCalculado === "no_aplica") {
    return { declarado: false, detalle: null, pagado: false };
  }
  const decl = paso.senales.find((s) => s.clave === "fx:declaracion-periodo");
  const pago = paso.senales.find((s) => s.clave === "x:pago_conciliado");
  return {
    declarado: decl?.estado === "ok",
    detalle: decl?.resumen ?? null,
    pagado: pago?.estado === "ok",
  };
}
