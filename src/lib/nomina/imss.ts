// ─── IMSS Cuotas Calculation ─────────────────────────────────────────────────
// Computes obrero (employee) and patronal (employer) IMSS contributions
// based on real stepped rates per Ley del Seguro Social.

import {
  UMA_DIARIO,
  UMA_EJERCICIO,
  IMSS_RAMOS,
  RIESGO_TRABAJO_PRIMAS,
  CEAV_REFERENCIAS,
  SALARIO_MINIMO_GENERAL,
  ceavPatronalRate,
} from "./constants";

export type ImssCalcInput = {
  salarioBaseCotizacion: number; // SBC diario
  diasPagados: number;
  riesgoPuesto: string; // "1"–"5"
  /**
   * Ejercicio (año de la fecha de pago). Selecciona la columna de la tabla
   * progresiva de CEAV patronal (Art. Segundo Transitorio, DOF 16-dic-2020).
   * Default: UMA_EJERCICIO — el año de los valores UMA/SM cargados en
   * constants, que es también el que usan los demás ramos (cuota fija,
   * excedente 3 UMA y tope 25 UMA siempre se calculan con la UMA vigente).
   */
  ejercicio?: number;
  /**
   * UMA diaria a usar para la cuota fija, el excedente de 3 UMA y el tope de
   * 25 UMA. Default: UMA_DIARIO (la vigente). Pasar la UMA histórica del
   * ejercicio (umaDiariaDelEjercicio) al recalcular periodos de años previos —
   * nómina en paralelo.
   */
  umaDiaria?: number;
  /**
   * CUOTA DIARIA del trabajador (salario diario, NO el SBC). Si es menor o
   * igual al salario mínimo general del ejercicio, el PATRÓN paga íntegra la
   * cuota obrera (Art. 36 LSS): al trabajador de salario mínimo no se le
   * retiene IMSS — los importes obreros se trasladan al patronal. Omitir
   * mantiene el comportamiento normal (retención obrera).
   */
  salarioDiario?: number;
};

export type ImssDesglose = {
  eymEspecieFija: number;
  eymEspecieExcedente: number;
  eymDinero: number;
  eymGastosMedicos: number;
  invalidezVida: number;
  retiro: number;
  cesantiaVejez: number;
  guarderias: number;
  riesgoTrabajo: number;
  total: number;
};

export type ImssCalcResult = {
  obrero: ImssDesglose;
  patronal: ImssDesglose;
};

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function calcularImss(input: ImssCalcInput): ImssCalcResult {
  const { diasPagados, riesgoPuesto } = input;
  const ejercicio = input.ejercicio ?? UMA_EJERCICIO;
  const umaDiaria = input.umaDiaria ?? UMA_DIARIO;

  // Cap SBC at 25 UMA
  const sbcDiario = Math.min(input.salarioBaseCotizacion, umaDiaria * 25);
  const sbcPeriodo = sbcDiario * diasPagados;

  // Excedente sobre 3 UMA (for EyM Especie Excedente)
  const excedente3Uma = Math.max(0, sbcDiario - umaDiaria * 3) * diasPagados;

  // UMA base for cuota fija
  const umaBase = umaDiaria * diasPagados;

  const obrero: ImssDesglose = {
    eymEspecieFija: 0, // employer-only
    eymEspecieExcedente: 0,
    eymDinero: 0,
    eymGastosMedicos: 0,
    invalidezVida: 0,
    retiro: 0, // employer-only
    cesantiaVejez: 0,
    guarderias: 0, // employer-only
    riesgoTrabajo: 0, // employer-only
    total: 0,
  };

  const patronal: ImssDesglose = {
    eymEspecieFija: 0,
    eymEspecieExcedente: 0,
    eymDinero: 0,
    eymGastosMedicos: 0,
    invalidezVida: 0,
    retiro: 0,
    cesantiaVejez: 0,
    guarderias: 0,
    riesgoTrabajo: 0,
    total: 0,
  };

  for (const ramo of IMSS_RAMOS) {
    let base = 0;
    if (ramo.base === "SBC") base = sbcPeriodo;
    else if (ramo.base === "EXCEDENTE_3UMA") base = excedente3Uma;
    else if (ramo.base === "UMA") base = umaBase;

    const obreroMonto = r2(base * ramo.obrero);
    const patronalMonto = r2(base * ramo.patronal);

    // Map ramo name to desglose field
    switch (ramo.nombre) {
      case "EyM Especie Fija":
        obrero.eymEspecieFija = obreroMonto;
        patronal.eymEspecieFija = patronalMonto;
        break;
      case "EyM Especie Excedente":
        obrero.eymEspecieExcedente = obreroMonto;
        patronal.eymEspecieExcedente = patronalMonto;
        break;
      case "EyM Dinero":
        obrero.eymDinero = obreroMonto;
        patronal.eymDinero = patronalMonto;
        break;
      case "EyM Gastos Médicos Pensionados":
        obrero.eymGastosMedicos = obreroMonto;
        patronal.eymGastosMedicos = patronalMonto;
        break;
      case "Invalidez y Vida":
        obrero.invalidezVida = obreroMonto;
        patronal.invalidezVida = patronalMonto;
        break;
      case "Retiro":
        obrero.retiro = obreroMonto;
        patronal.retiro = patronalMonto;
        break;
      case "Cesantía y Vejez":
        // Obrera: fija en 1.125% (Art. 168 fracc. II LSS — la reforma 2020 no
        // la modificó).
        obrero.cesantiaVejez = obreroMonto;
        // Patronal: PROGRESIVA por SBC desde 2023 (Art. 168 fracc. II LSS
        // reformado DOF 16-dic-2020; incremento gradual 2023-2030 conforme al
        // Art. Segundo Transitorio). El `ramo.patronal` fijo de constants es
        // sólo el piso de la banda ≤ 1 SM y NO debe aplicarse parejo.
        patronal.cesantiaVejez = r2(sbcPeriodo * ceavPatronalRate(sbcDiario, ejercicio));
        break;
      case "Guarderías":
        obrero.guarderias = obreroMonto;
        patronal.guarderias = patronalMonto;
        break;
    }
  }

  // Riesgo de Trabajo — employer only, rate by class
  const rtPrima = RIESGO_TRABAJO_PRIMAS[riesgoPuesto] ?? RIESGO_TRABAJO_PRIMAS["1"];
  patronal.riesgoTrabajo = r2(sbcPeriodo * rtPrima);

  // Art. 36 LSS: cuando el trabajador percibe como CUOTA DIARIA el salario
  // mínimo, corresponde al patrón pagar íntegramente la cuota obrera — no hay
  // retención de IMSS al trabajador (consistente con LFT Art. 97: el mínimo no
  // admite descuentos). Se compara contra el mínimo GENERAL del ejercicio
  // (tolerancia de centavos por redondeos de captura); cada ramo obrero se
  // traslada a su contraparte patronal para que el costo patronal total sea
  // correcto en la provisión.
  const smDiario =
    CEAV_REFERENCIAS[ejercicio]?.salarioMinimoDiario ?? SALARIO_MINIMO_GENERAL;
  if (input.salarioDiario != null && input.salarioDiario <= smDiario + 0.01) {
    const campos = [
      "eymEspecieFija", "eymEspecieExcedente", "eymDinero", "eymGastosMedicos",
      "invalidezVida", "retiro", "cesantiaVejez", "guarderias", "riesgoTrabajo",
    ] as const;
    for (const c of campos) {
      patronal[c] = r2(patronal[c] + obrero[c]);
      obrero[c] = 0;
    }
  }

  // Totals
  obrero.total = r2(
    obrero.eymEspecieFija + obrero.eymEspecieExcedente + obrero.eymDinero +
    obrero.eymGastosMedicos + obrero.invalidezVida + obrero.retiro +
    obrero.cesantiaVejez + obrero.guarderias + obrero.riesgoTrabajo
  );
  patronal.total = r2(
    patronal.eymEspecieFija + patronal.eymEspecieExcedente + patronal.eymDinero +
    patronal.eymGastosMedicos + patronal.invalidezVida + patronal.retiro +
    patronal.cesantiaVejez + patronal.guarderias + patronal.riesgoTrabajo
  );

  return { obrero, patronal };
}
