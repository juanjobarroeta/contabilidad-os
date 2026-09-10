// ─────────────────────────────────────────────────────────────────────────────
// ¿ESTE MES YA ESTÁ DECLARADO?
//
// Se DERIVA, no se guarda: la fuente es la misma señal del checklist que ya
// mira si la declaración del periodo está presentada. No se estira más allá
// de lo que dice: «declarado» es un hecho externo, no el estado del cierre.
// `estado-canonico.ts` decide si además está contabilizado, cerrado o bloqueado.
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
    return {
      declarado: cierre.estado.declarado,
      detalle:
        cierre.estado.origenCierre === "FUERA_DE_CONTABILIDAD_OS"
          ? "Declaración histórica importada."
          : null,
      pagado: false,
    };
  }
  const decl = paso.senales.find((s) => s.clave === "fx:declaracion-periodo");
  const pago = paso.senales.find((s) => s.clave === "x:pago_conciliado");
  return {
    // El estado canónico también reconoce una declaración histórica leída
    // directamente de la base, aun si el motor de pasos no pudo evaluarse.
    declarado: cierre.estado.declarado,
    detalle:
      decl?.resumen ??
      (cierre.estado.origenCierre === "FUERA_DE_CONTABILIDAD_OS"
        ? "Declaración histórica importada."
        : null),
    pagado: pago?.estado === "ok",
  };
}
