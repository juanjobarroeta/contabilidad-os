// ─────────────────────────────────────────────────────────────────────────────
// EL SALDO DEL ESTADO DE CUENTA NO SE PIDE DOS VECES.
//
// Hasta ahora cada mes tenía sus dos cajitas vacías —saldo inicial y saldo
// final— y había que teclearlas aunque el mes anterior ya estuviera capturado.
// Es trabajo inventado: un saldo de banco es una serie encadenada. Con UN ancla
// (un saldo capturado alguna vez, o el que trae un estado de cuenta importado)
// y los movimientos, cualquier otro mes se calcula:
//
//     saldo(fecha) = saldo(ancla) + Σ movimientos entre el ancla y esa fecha
//
// Se pregunta sólo cuando no hay ancla en ninguna parte. Y cada cifra viaja con
// su PROCEDENCIA: un saldo calculado no se presenta como uno capturado — si los
// movimientos del mes están incompletos, el arrastre hereda el hueco, y quien
// lo lea tiene derecho a saberlo.
// ─────────────────────────────────────────────────────────────────────────────

/** De dónde salió un saldo. */
export type FuenteSaldo =
  | "capturado" // lo tecleó una persona para ESTE mes
  | "estado" // lo trae el estado de cuenta importado del periodo
  | "arrastre" // viene encadenado desde el último saldo conocido
  | "calculado" // saldo inicial + movimientos del propio mes
  | "sin-dato"; // no hay ancla en ninguna parte: hay que capturarlo una vez

export interface SaldoConFuente {
  valor: number | null;
  fuente: FuenteSaldo;
  /** Legible: «del estado de cuenta de agosto», «arrastrado desde mayo 2026». */
  etiqueta: string;
}

const SIN_DATO: SaldoConFuente = {
  valor: null,
  fuente: "sin-dato",
  etiqueta: "sin dato — captúralo una vez y los meses siguientes se calculan solos",
};

export interface EntradasSaldo {
  /** Lo capturado para ESTE mes (ConciliacionBancaria). */
  capturadoInicial: number | null;
  capturadoFinal: number | null;
  /** Lo que declara el estado de cuenta importado de ESTE periodo. */
  estadoInicial: number | null;
  estadoFinal: number | null;
  /**
   * Ancla: el saldo conocido más reciente en o antes de este mes, y el neto de
   * los movimientos entre ese punto y el primer día del mes. `null` si no hay
   * ningún saldo conocido en la historia de la cuenta.
   */
  ancla: { saldo: number; etiqueta: string; netoHastaInicioDelMes: number } | null;
  /** Neto (firmado) de los movimientos del propio mes. */
  netoDelMes: number;
}

export interface SaldosResueltos {
  inicial: SaldoConFuente;
  final: SaldoConFuente;
}

const redondear = (n: number) => Math.round(n * 100) / 100;

/**
 * Resuelve los dos saldos del mes con su procedencia. PURA: los insumos los
 * junta el repo. El orden de preferencia es el de la confianza, no el de la
 * comodidad — lo capturado gana siempre, y lo calculado sólo entra cuando hay
 * de dónde calcularlo.
 */
export function resolverSaldos(e: EntradasSaldo): SaldosResueltos {
  const inicial: SaldoConFuente =
    e.capturadoInicial != null
      ? { valor: e.capturadoInicial, fuente: "capturado", etiqueta: "capturado a mano" }
      : e.estadoInicial != null
        ? { valor: e.estadoInicial, fuente: "estado", etiqueta: "del estado de cuenta importado" }
        : e.ancla != null
          ? {
              valor: redondear(e.ancla.saldo + e.ancla.netoHastaInicioDelMes),
              fuente: "arrastre",
              etiqueta: `arrastrado desde ${e.ancla.etiqueta}`,
            }
          : SIN_DATO;

  const final: SaldoConFuente =
    e.capturadoFinal != null
      ? { valor: e.capturadoFinal, fuente: "capturado", etiqueta: "capturado a mano" }
      : e.estadoFinal != null
        ? { valor: e.estadoFinal, fuente: "estado", etiqueta: "del estado de cuenta importado" }
        : inicial.valor != null
          ? {
              valor: redondear(inicial.valor + e.netoDelMes),
              fuente: "calculado",
              // Se dice de dónde sale el inicial también: un final calculado
              // sobre un inicial arrastrado no es más firme que su arrastre.
              etiqueta:
                inicial.fuente === "arrastre"
                  ? `calculado: ${inicial.etiqueta} + los movimientos del mes`
                  : "calculado: saldo inicial + los movimientos del mes",
            }
          : SIN_DATO;

  return { inicial, final };
}

/** ¿Este saldo lo puso una persona o un documento, y no un cálculo nuestro? */
export function esSaldoDeFuenteDura(f: FuenteSaldo): boolean {
  return f === "capturado" || f === "estado";
}
