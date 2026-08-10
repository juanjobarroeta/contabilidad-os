// ─────────────────────────────────────────────────────────────────────────────
// Plazo legal del complemento de pago (REP).
//
// RMF regla 2.7.1.32 (antes 2.7.1.35): el REP debe emitirse a más tardar el
// QUINTO día natural del mes inmediato siguiente al que se recibió el pago.
// Un cobro del 20 de julio ⇒ REP a más tardar el 5 de agosto.
//
// Módulo PURO — alimenta el centro de complementos (aviso de vencimiento) sin
// tocar BD ni red.
// ─────────────────────────────────────────────────────────────────────────────

/** Fecha límite para emitir el REP de un pago: día 5 del mes siguiente (fin de día UTC). */
export function fechaLimiteRep(fechaPago: Date): Date {
  return new Date(Date.UTC(fechaPago.getUTCFullYear(), fechaPago.getUTCMonth() + 1, 5, 23, 59, 59, 999));
}

/** True si el plazo del REP para ese pago ya venció. */
export function repVencido(fechaPago: Date, hoy: Date): boolean {
  return hoy.getTime() > fechaLimiteRep(fechaPago).getTime();
}

const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];

/** "vence el 5 de agosto" / "venció el 5 de agosto" según hoy. */
export function etiquetaPlazoRep(fechaPago: Date, hoy: Date): string {
  const limite = fechaLimiteRep(fechaPago);
  const verbo = repVencido(fechaPago, hoy) ? "venció" : "vence";
  return `${verbo} el 5 de ${MESES[limite.getUTCMonth()]}`;
}
