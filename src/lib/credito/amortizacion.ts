// ─────────────────────────────────────────────────────────────────────────────
// Matemática de préstamos (sistema francés: pago fijo mensual).
//
// El flujo del simulador va al revés del típico: se parte de CUÁNTO PUEDE
// PAGAR el cliente al mes (fracción de su flujo libre según su banda de
// riesgo), y con tasa y plazo se deriva CUÁNTO PRESTARLE — el valor presente
// de esa anualidad. La tabla muestra pago/interés/capital/saldo por mes.
//
// Módulo PURO y sin dependencias: se usa igual en servidor y en el cliente
// (la ficha lo corre en vivo con los inputs del operador).
// ─────────────────────────────────────────────────────────────────────────────

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Pago mensual fijo para un monto, tasa anual nominal (0.36 = 36%) y plazo en meses. */
export function pagoMensual(monto: number, tasaAnual: number, plazoMeses: number): number {
  if (monto <= 0 || plazoMeses <= 0) return 0;
  const r = tasaAnual / 12;
  if (r === 0) return r2(monto / plazoMeses);
  return r2((monto * r) / (1 - Math.pow(1 + r, -plazoMeses)));
}

/** Monto máximo prestable dado un pago mensual, tasa anual y plazo (VP de la anualidad). */
export function montoPorPago(pago: number, tasaAnual: number, plazoMeses: number): number {
  if (pago <= 0 || plazoMeses <= 0) return 0;
  const r = tasaAnual / 12;
  if (r === 0) return r2(pago * plazoMeses);
  return r2((pago * (1 - Math.pow(1 + r, -plazoMeses))) / r);
}

export interface RenglonAmortizacion {
  mes: number;
  pago: number;
  interes: number;
  capital: number;
  saldo: number;
}

/**
 * Tabla de amortización francesa. El último renglón absorbe el residuo de
 * redondeo para que el saldo cierre exactamente en cero.
 */
export function tablaAmortizacion(
  monto: number,
  tasaAnual: number,
  plazoMeses: number,
): RenglonAmortizacion[] {
  if (monto <= 0 || plazoMeses <= 0) return [];
  const r = tasaAnual / 12;
  const pago = pagoMensual(monto, tasaAnual, plazoMeses);
  const filas: RenglonAmortizacion[] = [];
  let saldo = monto;
  for (let mes = 1; mes <= plazoMeses; mes++) {
    const interes = r2(saldo * r);
    let capital = r2(pago - interes);
    let pagoMes = pago;
    if (mes === plazoMeses) {
      // Cierre exacto: el último pago liquida el saldo restante.
      capital = r2(saldo);
      pagoMes = r2(capital + interes);
    }
    saldo = r2(saldo - capital);
    filas.push({ mes, pago: pagoMes, interes, capital, saldo: Math.max(0, saldo) });
  }
  return filas;
}

/**
 * Pago mensual máximo recomendado: fracción del flujo libre según la banda
 * (razón de cobertura de servicio de deuda). Un cliente A puede comprometer
 * más de su flujo que un C.
 */
export function pagoMaximoPorBanda(flujoLibreMensual: number, banda: string): number {
  const theta = banda === "A" ? 0.4 : banda === "B" ? 0.3 : banda === "C" ? 0.2 : 0;
  return r2(Math.max(0, flujoLibreMensual) * theta);
}
