// ─────────────────────────────────────────────────────────────────────────────
// Reglas PURAS del ejercicio contable — Fase 3.2.
//
// Sin Prisma a propósito: el panel de Contabilidad es un componente de cliente y
// necesita evaluar "¿se puede cerrar este ejercicio?" con los periodos que ya
// tiene en memoria, sin arrastrar el cliente de base de datos al bundle ni
// pedir otra vuelta al servidor. El lado que escribe (guardas, cerrar, reabrir)
// vive en candado.ts y reutiliza estas mismas reglas, así que el UI y el API
// nunca pueden discrepar.
// ─────────────────────────────────────────────────────────────────────────────

import type { AccountingPeriodStatus } from "@prisma/client";

/** Meses que componen un ejercicio en el libro: 1-12 más el mes 13 de cierre. */
export const MESES_EJERCICIO = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

export class PeriodoCerradoError extends Error {
  readonly status = 409;
  constructor(readonly year: number, readonly month: number) {
    super(
      `El ejercicio ${year} está cerrado, así que ${
        month === 13 ? "el asiento de cierre" : `el mes ${month}`
      } ya no admite movimientos. Si necesitas corregirlo, reabre el ejercicio en Contabilidad › Cierres mensuales.`
    );
    this.name = "PeriodoCerradoError";
  }
}

export class EjercicioError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "EjercicioError";
  }
}

export interface PeriodoResumen {
  month: number;
  status: AccountingPeriodStatus;
  entriesCount: number;
}

export interface EvaluacionCierre {
  puedeCerrar: boolean;
  yaCerrado: boolean;
  /** Meses 1-12 con asientos que siguen en borrador. */
  mesesEnBorrador: number[];
  /** No existe todavía el asiento de cierre del mes 13. */
  faltaCierre: boolean;
  /** Explicación en español de por qué NO se puede cerrar (null si sí se puede). */
  motivo: string | null;
}

/**
 * Reglas para cerrar un ejercicio, sin tocar la base:
 *   1. No puede estar ya cerrado.
 *   2. Ningún mes 1-12 con asientos puede seguir en borrador — cerrar el año
 *      con trabajo a medio postear congelaría cifras que no son las finales.
 *      Un mes en borrador y VACÍO no estorba (simplemente no hubo operaciones).
 *   3. Debe existir el asiento de cierre (mes 13): sin él, las cuentas de
 *      resultados nunca se cancelaron contra capital.
 */
export function evaluarCierreEjercicio(periodos: PeriodoResumen[]): EvaluacionCierre {
  const conAlgo = periodos.filter((p) => p.entriesCount > 0);
  const yaCerrado = conAlgo.length > 0 && conAlgo.every((p) => p.status === "CLOSED");

  const mesesEnBorrador = periodos
    .filter((p) => p.month >= 1 && p.month <= 12 && p.status === "DRAFT" && p.entriesCount > 0)
    .map((p) => p.month)
    .sort((a, b) => a - b);

  const faltaCierre = !periodos.some((p) => p.month === 13 && p.entriesCount > 0);

  let motivo: string | null = null;
  if (yaCerrado) {
    motivo = "El ejercicio ya está cerrado.";
  } else if (mesesEnBorrador.length > 0) {
    motivo = `Faltan meses por cerrar: ${mesesEnBorrador.join(", ")}. Ciérralos antes de cerrar el ejercicio.`;
  } else if (faltaCierre) {
    motivo = "Falta el asiento de cierre (mes 13). Genéralo con el botón «Cierre» antes de cerrar el ejercicio.";
  }

  return { puedeCerrar: motivo === null, yaCerrado, mesesEnBorrador, faltaCierre, motivo };
}
