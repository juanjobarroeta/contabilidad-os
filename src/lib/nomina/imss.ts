// ─── IMSS Cuotas Calculation ─────────────────────────────────────────────────
// Computes obrero (employee) and patronal (employer) IMSS contributions
// based on real stepped rates per Ley del Seguro Social.

import {
  TOPE_SBC_25_UMA,
  TRES_UMA,
  UMA_DIARIO,
  IMSS_RAMOS,
  RIESGO_TRABAJO_PRIMAS,
} from "./constants";

export type ImssCalcInput = {
  salarioBaseCotizacion: number; // SBC diario
  diasPagados: number;
  riesgoPuesto: string; // "1"–"5"
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

  // Cap SBC at 25 UMA
  const sbcDiario = Math.min(input.salarioBaseCotizacion, TOPE_SBC_25_UMA);
  const sbcPeriodo = sbcDiario * diasPagados;

  // Excedente sobre 3 UMA (for EyM Especie Excedente)
  const excedente3Uma = Math.max(0, sbcDiario - TRES_UMA) * diasPagados;

  // UMA base for cuota fija
  const umaBase = UMA_DIARIO * diasPagados;

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
        obrero.cesantiaVejez = obreroMonto;
        patronal.cesantiaVejez = patronalMonto;
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
