// ─────────────────────────────────────────────────────────────────────────────
// LIQUIDACIONES DE TERMINAL — el sufijo de la afiliación dice qué tarjeta fue.
//
// El banco liquida por afiliación Y por tipo de tarjeta, con un sufijo en la
// descripción: «HOSP HALTUS 09992888C» es el lote de CRÉDITO y «…D» el de
// DÉBITO. Del otro lado, el CFDI ya lo declara con la forma de pago del SAT:
// 04 tarjeta de crédito, 28 tarjeta de débito.
//
// Son dos mitades del mismo hecho, y cuando se contradicen ese dinero NO pudo
// liquidar esa factura. Medido en un hospital real: de 751 candidatos ofrecidos
// para depósitos de terminal, 258 —el 34 %— eran de la tarjeta contraria. Uno
// llegó a la pantalla como sugerencia «media» con $58.84 de diferencia, que
// parecía una comisión y era un lote de crédito contra una factura de débito.
// ─────────────────────────────────────────────────────────────────────────────

/** Forma de pago del SAT. */
export const FORMA_CREDITO = "04";
export const FORMA_DEBITO = "28";

export type TipoTarjeta = "CREDITO" | "DEBITO";

/** Afiliación de terminal seguida de C (crédito) o D (débito). */
const RE_AFILIACION = /\b\d{7,}([CD])\b/;

/**
 * ¿Este movimiento es la liquidación de una terminal, y de qué tarjeta? PURA.
 *
 * Devuelve null cuando no se puede leer el sufijo — sin dato no se descarta
 * nada, que es lo correcto: la regla sólo debe actuar sobre lo que sabe.
 */
export function tarjetaDeLiquidacion(descripcion: string): TipoTarjeta | null {
  const m = RE_AFILIACION.exec(descripcion ?? "");
  if (!m) return null;
  return m[1] === "C" ? "CREDITO" : "DEBITO";
}

/**
 * ¿La forma de pago del CFDI CONTRADICE la tarjeta del lote? PURA.
 *
 * Sólo la contradicción explícita cuenta: crédito contra débito o al revés.
 * Una factura con forma «99 por definir», efectivo o transferencia NO se
 * descarta — puede estar mal capturada, y esta regla no debe esconder la
 * respuesta correcta por un dato que el emisor no llenó.
 */
export function tarjetaContradice(
  tarjeta: TipoTarjeta | null,
  formaPago: string | null | undefined,
): boolean {
  if (!tarjeta || !formaPago) return false;
  if (tarjeta === "CREDITO") return formaPago === FORMA_DEBITO;
  return formaPago === FORMA_CREDITO;
}

/**
 * ¿Un candidato «cerca pero no exacto» en un lote de terminal? PURA.
 *
 * Una liquidación de terminal es la SUMA de los cargos del día, así que una
 * factura sola que se le parece al 0.3 % no es una pista: es una coincidencia
 * entre dos números grandes. Y no hay comisión que justifique la diferencia —
 * está verificado que estos depósitos vienen en BRUTO: el reporte diario del
 * adquirente cuadra al centavo con lo depositado, y la tasa de descuento se
 * cobra en renglones aparte.
 *
 * Medido: de 751 candidatos ofrecidos para depósitos de terminal, 397 eran de
 * esta clase — salían como «media» e invitaban a conciliar un lote entero
 * contra la factura de un solo paciente.
 *
 * El importe EXACTO sí cuenta: un lote de un solo cargo existe y es legítimo.
 */
export function cercaPeroNoExactoEnLote(
  esLiquidacion: boolean,
  totalFactura: number,
  montoMovimiento: number,
): boolean {
  if (!esLiquidacion) return false;
  return Math.abs(totalFactura - Math.abs(montoMovimiento)) >= 0.01;
}
