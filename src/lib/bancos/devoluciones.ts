// ─────────────────────────────────────────────────────────────────────────────
// Devoluciones bancarias (pagos rebotados): detección y validación PURAS.
//
// Caso real que motivó esto: un SPEI enviado de $22,732.50 (conciliado con una
// factura de proveedor) rebotó el mismo día — "SPEI DEVUELTO", misma
// referencia, monto opuesto. El usuario marcó la devolución como "Ignorado",
// que esconde el rebote pero deja TRES mentiras en pie: la factura parece
// pagada, el IVA acreditable del mes existe sin haberse pagado efectivamente
// (flujo), y los KPIs cuentan un gasto y un ingreso que se netean.
//
// El modelo correcto es VINCULAR el par (BankTransaction.devolucionDeId):
// ambos movimientos quedan IGNORED (fuera de KPIs y del motor de IVA) pero el
// vínculo conserva la historia, y al vincular se DESHACE la conciliación del
// original (la factura vuelve a no-pagada). "Ignorar" es destructivo para la
// narrativa; el par es un evento contable auditable.
//
// La detección propone y el humano decide (misma filosofía que el resto del
// sistema): el par del caso real coincide en referencia, monto exacto y fecha
// — señales de altísima confianza.
// ─────────────────────────────────────────────────────────────────────────────

/** Ventana máxima entre el pago original y su devolución. */
export const DEVOLUCION_VENTANA_DIAS = 30;

/** Tolerancia de centavos al comparar montos opuestos. */
const TOLERANCIA = 0.01;

const DIA_MS = 24 * 60 * 60 * 1000;

/** ¿La descripción huele a devolución/rechazo bancario? */
export function esDescripcionDevolucion(descripcion: string | null | undefined): boolean {
  if (!descripcion) return false;
  return /DEVUELT|DEVOLUCI|RECHAZ|REVERS/i.test(descripcion);
}

export interface MovimientoPar {
  id: string;
  bankAccountId: string;
  fecha: Date;
  monto: number;
  descripcion: string;
  referencia: string | null;
}

/**
 * Valida que `devolucion` pueda ser la devolución de `origen`. Devuelve null
 * si el par es válido, o el motivo (en español, para el 422) si no.
 */
export function validarParDevolucion(
  devolucion: MovimientoPar,
  origen: MovimientoPar,
): string | null {
  if (devolucion.id === origen.id) return "Un movimiento no puede ser su propia devolución.";
  if (devolucion.bankAccountId !== origen.bankAccountId)
    return "La devolución y el pago original deben ser de la misma cuenta bancaria.";
  if (Math.abs(devolucion.monto + origen.monto) > TOLERANCIA)
    return "Los montos no se netean: la devolución debe ser el monto opuesto exacto del pago original.";
  if (devolucion.monto === 0 || origen.monto === 0) return "Los montos no pueden ser cero.";
  const dias = (devolucion.fecha.getTime() - origen.fecha.getTime()) / DIA_MS;
  if (dias < 0) return "La devolución no puede ser anterior al pago original.";
  if (dias > DEVOLUCION_VENTANA_DIAS)
    return `La devolución está a más de ${DEVOLUCION_VENTANA_DIAS} días del pago original.`;
  return null;
}

/**
 * Puntúa qué tan probable es que `origen` sea el pago devuelto por
 * `devolucion` (mayor = mejor). Sólo se llama sobre pares ya válidos.
 *   +2 referencia idéntica (señal casi determinante en SPEI)
 *   +1 descripción de la devolución menciona devolución/rechazo
 *   +1 mismo día; decae con la distancia en días
 */
export function puntuarParDevolucion(devolucion: MovimientoPar, origen: MovimientoPar): number {
  let score = 0;
  if (devolucion.referencia && origen.referencia && devolucion.referencia === origen.referencia)
    score += 2;
  if (esDescripcionDevolucion(devolucion.descripcion)) score += 1;
  const dias = Math.abs(devolucion.fecha.getTime() - origen.fecha.getTime()) / DIA_MS;
  score += Math.max(0, 1 - dias / DEVOLUCION_VENTANA_DIAS);
  return score;
}

/**
 * Elige el mejor candidato a pago original para una devolución, o null si
 * ninguno es válido. `candidatos` deben ser movimientos de la misma cuenta.
 * Sólo propone cuando hay señal fuerte (score ≥ 2): referencia idéntica, o
 * descripción de devolución + cercanía. Ante empate gana el más cercano.
 */
export function elegirOrigenDevolucion(
  devolucion: MovimientoPar,
  candidatos: MovimientoPar[],
): MovimientoPar | null {
  let mejor: MovimientoPar | null = null;
  let mejorScore = 0;
  for (const c of candidatos) {
    if (validarParDevolucion(devolucion, c) !== null) continue;
    const s = puntuarParDevolucion(devolucion, c);
    if (s > mejorScore) {
      mejor = c;
      mejorScore = s;
    }
  }
  return mejorScore >= 2 ? mejor : null;
}
