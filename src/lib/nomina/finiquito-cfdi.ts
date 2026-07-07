// ─── Finiquito → percepciones CFDI y columnas de PayrollItem ─────────────────
// Mapeo PURO (sin Prisma ni red) del desglose de calcularFiniquito
// (finiquito.ts) a:
//   1) las percepciones del complemento de nómina del CFDI de separación,
//      respetando la separación gravado/exento que YA hizo el cálculo
//      (aguinaldo 30 UMA y prima vacacional 15 UMA — Art. 93 fracc. XIV LISR;
//      prima de antigüedad 90 UMA — Art. 93 fracc. XIII LISR), y
//   2) las columnas de PayrollItem con las que se persiste la corrida FINIQUITO.
//
// Claves c_TipoPercepcion (catálogo SAT del complemento de nómina):
//   001 Sueldos, Salarios Rayas y Jornales — salarios pendientes de pago y
//       vacaciones proporcionales no disfrutadas (se pagan como salario).
//   002 Gratificación Anual (Aguinaldo) — parte proporcional (Art. 87 LFT).
//   021 Prima Vacacional — proporcional (Art. 80 LFT).
//   022 Prima por Antigüedad — 12 días por año, tope 2 UMA (Art. 162 LFT).
//   025 Indemnizaciones — 3 meses de SDI + 20 días por año (Art. 50 LFT).
// Las claves 022/025 son las mismas que la importación de CFDIs del SAT ya
// reconoce como señal de separación (roster-import.ts / historia-import.ts):
// el recibo timbrado con este desglose se re-clasifica como FINIQUITO al
// reimportarse.

import type { PercepcionItem } from "./calc-nomina";
import type { FiniquitoDesglose } from "./finiquito";

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Percepciones del CFDI de separación a partir del desglose del finiquito.
 * Sólo se emiten renglones con importe > 0; la suma de gravado + exento de
 * todos los renglones reproduce exactamente totalBruto / totalExento /
 * totalGravado del cálculo.
 */
export function percepcionesFiniquito(d: FiniquitoDesglose): PercepcionItem[] {
  const percepciones: PercepcionItem[] = [];

  // Salarios devengados y no pagados a la fecha de baja — 100% gravados.
  if (d.salariosPendientes > 0) {
    percepciones.push({
      tipoPercepcion: "001",
      clave: "001",
      concepto: "Sueldos, Salarios y Rayas (pendientes a la baja)",
      importeGravado: d.salariosPendientes,
      importeExento: 0,
    });
  }

  // Aguinaldo proporcional (Art. 87 LFT) — exención de 30 UMA ya aplicada.
  if (d.aguinaldoProporcional > 0) {
    percepciones.push({
      tipoPercepcion: "002",
      clave: "002",
      concepto: "Gratificación Anual (Aguinaldo) proporcional",
      importeGravado: d.aguinaldoGravado,
      importeExento: d.aguinaldoExento,
    });
  }

  // Vacaciones proporcionales no disfrutadas (Arts. 76 y 79 LFT): se pagan
  // como salario, 100% gravadas. Clave interna distinta a la de los salarios
  // pendientes para no fusionar conceptos en el recibo.
  if (d.vacacionesProporcionales > 0) {
    percepciones.push({
      tipoPercepcion: "001",
      clave: "046",
      concepto: "Vacaciones proporcionales no disfrutadas",
      importeGravado: d.vacacionesProporcionales,
      importeExento: 0,
    });
  }

  // Prima vacacional proporcional (Art. 80 LFT) — exención de 15 UMA ya
  // aplicada por el cálculo.
  if (d.primaVacacional > 0) {
    percepciones.push({
      tipoPercepcion: "021",
      clave: "021",
      concepto: "Prima Vacacional proporcional",
      importeGravado: d.primaVacacionalGravada,
      importeExento: d.primaVacacionalExenta,
    });
  }

  // Indemnizaciones del despido injustificado (Art. 50 LFT): 3 meses de SDI
  // + 20 días por año. SIMPLIFICACIÓN DOCUMENTADA (heredada de finiquito.ts):
  // la exención del Art. 93 fracc. XIII LISR (90 UMA) se aplica contra la
  // prima de antigüedad; las indemnizaciones se reportan gravadas.
  const indemnizaciones = r2(d.indemnizacion3Meses + d.indemnizacion20Dias);
  if (indemnizaciones > 0) {
    percepciones.push({
      tipoPercepcion: "025",
      clave: "025",
      concepto: "Indemnización (3 meses + 20 días por año, Art. 50 LFT)",
      importeGravado: indemnizaciones,
      importeExento: 0,
    });
  }

  // Prima de antigüedad (Art. 162 LFT) — exención de 90 UMA (Art. 93
  // fracc. XIII LISR) ya aplicada por el cálculo.
  if (d.primaAntiguedad > 0) {
    percepciones.push({
      tipoPercepcion: "022",
      clave: "022",
      concepto: "Prima por Antigüedad (Art. 162 LFT)",
      importeGravado: r2(d.primaAntiguedad - d.primaAntiguedadExenta),
      importeExento: d.primaAntiguedadExenta,
    });
  }

  return percepciones;
}

/**
 * Columnas de percepciones de PayrollItem para la corrida FINIQUITO. La
 * indemnización y la prima de antigüedad van a `otrasPercepciones` — no hay
 * columna propia, y es el mismo destino que la importación SAT da a las
 * claves 022/025 (historia-import.ts).
 */
export function camposItemFiniquito(d: FiniquitoDesglose): {
  sueldoBase: number;
  aguinaldo: number;
  vacaciones: number;
  primaVacacional: number;
  otrasPercepciones: number;
} {
  return {
    sueldoBase: d.salariosPendientes,
    aguinaldo: d.aguinaldoProporcional,
    vacaciones: d.vacacionesProporcionales,
    primaVacacional: d.primaVacacional,
    otrasPercepciones: r2(d.indemnizacion3Meses + d.indemnizacion20Dias + d.primaAntiguedad),
  };
}
