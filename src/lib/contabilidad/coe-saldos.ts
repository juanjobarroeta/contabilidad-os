// ─────────────────────────────────────────────────────────────────────────────
// Saldos para la Balanza de Comprobación (Anexo 24) — lógica pura, sin DB.
//
// SAT exige: SaldoFin = SaldoIni + (cargos − abonos) según la naturaleza de la
// cuenta, y los importes se reportan como MAGNITUD no negativa (el signo lo
// implica la naturaleza/CodAgrup). Aquí calculamos los saldos CON signo natural;
// el generador XML emite el valor absoluto.
// ─────────────────────────────────────────────────────────────────────────────

export type Naturaleza = "D" | "A";

/** Naturaleza por defecto según el tipo de cuenta. Las cuentas de contra-activo
 * (depreciación acumulada, estimaciones) deben sobreescribirla a "A". */
export function naturalezaPorTipo(tipo: string): Naturaleza {
  return ["ACTIVO", "GASTO", "COSTO"].includes(tipo) ? "D" : "A";
}

/**
 * Saldo inicial y final CON SIGNO NATURAL del periodo:
 *   • deudora (D): saldo = cargos − abonos
 *   • acreedora (A): saldo = abonos − cargos
 * saldoInicial usa los movimientos PREVIOS al periodo; saldoFinal añade los del
 * periodo. (El generador XML emite |saldo|.)
 */
export function saldosCoe(args: {
  naturaleza: Naturaleza;
  priorCargos: number;
  priorAbonos: number;
  cargos: number;
  abonos: number;
}): { saldoInicial: number; saldoFinal: number } {
  const dir = args.naturaleza === "D" ? 1 : -1;
  // `+ 0` normaliza el -0 (p.ej. -1 * 0) a +0.
  const saldoInicial = dir * (args.priorCargos - args.priorAbonos) + 0;
  const saldoFinal = saldoInicial + dir * (args.cargos - args.abonos) + 0;
  return { saldoInicial, saldoFinal };
}
