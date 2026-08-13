// ─────────────────────────────────────────────────────────────────────────────
// Saldo bancario de fin de mes para la evaluación de crédito.
//
// Se calculaba con el saldo del ÚLTIMO movimiento del mes (`BankTransaction.
// saldo`), y eso está mal por dos razones:
//
//   1. Esa columna es OPCIONAL. Muchos estados de cuenta no traen saldo
//      corrido, así que el mes entero desaparecía de la serie.
//   2. Con VARIAS cuentas, el "último movimiento del mes" es el de UNA cuenta
//      cualquiera — la que casualmente movió al último. Su saldo se reportaba
//      como el saldo de la empresa, ignorando las demás. De ahí salen saldos
//      negativos en una empresa que sí tiene dinero: se leyó la cuenta
//      sobregirada y se ignoró la que tiene el efectivo.
//
// El dato bueno ya lo teníamos: el PDF declara su saldo inicial y su saldo
// final, se guardan en ImportBatch y la conciliación bancaria ya los usa. Aquí
// se usan también: por periodo se toma el lote MÁS RECIENTE de cada cuenta (una
// reimportación pisa a la anterior) y se SUMAN las cuentas.
//
// El saldo corrido queda como respaldo para los meses sin estado de cuenta.
//
// PURO.
// ─────────────────────────────────────────────────────────────────────────────

export interface LoteSaldo {
  /** "YYYY-MM" */
  periodo: string | null;
  bankAccountId: string;
  saldoFinal: number | null;
  /** Para quedarse con la reimportación más reciente de esa cuenta y periodo. */
  createdAt: Date;
}

export interface SaldoMes {
  periodo: string;
  saldo: number;
  /** De dónde salió: el estado de cuenta o el saldo corrido del movimiento. */
  fuente: "estado" | "movimiento";
  /** Cuentas sumadas (sólo cuando viene del estado). */
  cuentas?: number;
}

/**
 * Saldos de fin de mes, prefiriendo lo que declaró el estado de cuenta.
 *
 * @param lotes         ImportBatch con saldo final (no deshechos).
 * @param porMovimiento Saldo corrido por periodo, como respaldo.
 */
export function saldosFinDeMes(
  lotes: readonly LoteSaldo[],
  porMovimiento: ReadonlyMap<string, number>
): SaldoMes[] {
  // periodo → (cuenta → saldo del lote más reciente)
  const porPeriodo = new Map<string, Map<string, { saldo: number; createdAt: Date }>>();

  for (const l of lotes) {
    if (!l.periodo || l.saldoFinal == null) continue;
    const cuentas = porPeriodo.get(l.periodo) ?? new Map();
    const previo = cuentas.get(l.bankAccountId);
    // Una reimportación posterior de la MISMA cuenta y periodo pisa a la
    // anterior; sumarlas contaría el saldo dos veces.
    if (!previo || l.createdAt > previo.createdAt) {
      cuentas.set(l.bankAccountId, { saldo: l.saldoFinal, createdAt: l.createdAt });
    }
    porPeriodo.set(l.periodo, cuentas);
  }

  const out = new Map<string, SaldoMes>();

  for (const [periodo, cuentas] of porPeriodo) {
    let suma = 0;
    for (const c of cuentas.values()) suma += c.saldo;
    out.set(periodo, { periodo, saldo: suma, fuente: "estado", cuentas: cuentas.size });
  }

  // Respaldo: sólo para los meses que ningún estado de cuenta cubre.
  for (const [periodo, saldo] of porMovimiento) {
    if (!out.has(periodo)) out.set(periodo, { periodo, saldo, fuente: "movimiento" });
  }

  return [...out.values()].sort((a, b) => a.periodo.localeCompare(b.periodo));
}
