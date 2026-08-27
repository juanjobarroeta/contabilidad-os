// ─── Incidencias del periodo → insumo del cálculo de nómina ─────────────────
// Convierte las incidencias capturadas (faltas, incapacidades, horas extra,
// vacaciones, bonos, comisiones, descuentos) en el resumen que consume
// calcularNomina para una corrida ORDINARIA.
//
// Tratamiento por tipo (la base legal detallada vive junto al cálculo en
// calc-nomina.ts y prestaciones.ts):
// - FALTA / FALTA_JUSTIFICADA / PERMISO_SIN_GOCE → días NO pagados: reducen el
//   sueldo y los días de cotización IMSS del periodo. La falta "justificada"
//   sólo documenta la causa; salvo pacto en contrario no genera salario
//   (Art. 82 LFT: el salario se paga por el trabajo prestado).
// - INCAPACIDAD → días NO pagados por el patrón (el subsidio lo cubre el IMSS:
//   enfermedad general desde el día 4, Art. 96 LSS; riesgo de trabajo y
//   maternidad al 100%, Arts. 58 y 101 LSS). Se excluyen del sueldo, de la
//   base de ISR y de los días de cotización (ver simplificación documentada en
//   calc-nomina.ts).
// - VACACIONES → los días se pagan como sueldo normal (sin cambio en días
//   pagados); generan prima vacacional del 25% con exención de 15 UMA
//   (Art. 80 LFT; Art. 93 fracc. XIV LISR).
// - HORAS_EXTRA → dobles/triples con la exención del Art. 93 fracc. I LISR
//   (ver calcularHorasExtra en prestaciones.ts).
// - BONO / COMISION → percepciones 100% gravadas del periodo (Arts. 94 y 96
//   LISR — no aparecen en las exenciones del Art. 93).
// - DESCUENTO → deducción neta post-impuestos (préstamos, uniformes, etc.):
//   no altera ISR ni IMSS, sólo el neto a pagar.
// - PERMISO_CON_GOCE / RETARDO → sin efecto monetario en esta versión: el
//   permiso con goce se paga normal y el retardo sólo queda documentado.

import { prisma } from "../prisma";
import type { Incidencia } from "@prisma/client";

export type IncidenciasResumen = {
  /** Días no pagados por ausencia: FALTA + FALTA_JUSTIFICADA + PERMISO_SIN_GOCE. */
  diasFalta: number;
  /** Días de incapacidad (no pagados por el patrón; subsidio IMSS). */
  diasIncapacidad: number;
  /** Días de vacaciones tomados en el periodo (pagados normal; generan prima). */
  diasVacaciones: number;
  /** Horas extra dobles del periodo (Art. 67 LFT). */
  horasExtraDobles: number;
  /** Horas extra triples del periodo (Art. 68 LFT — exceden el límite legal). */
  horasExtraTriples: number;
  /** Bonos / gratificaciones / destajo del periodo (100% gravados). */
  bonos: number;
  /** Comisiones del periodo (100% gravadas). */
  comisiones: number;
  /** Descuentos netos post-impuestos del periodo. */
  descuentos: number;
  /** Número de incidencias consideradas (informativo). */
  numIncidencias: number;
};

export const RESUMEN_VACIO: IncidenciasResumen = {
  diasFalta: 0,
  diasIncapacidad: 0,
  diasVacaciones: 0,
  horasExtraDobles: 0,
  horasExtraTriples: 0,
  bonos: 0,
  comisiones: 0,
  descuentos: 0,
  numIncidencias: 0,
};

/** Subconjunto de campos de Incidencia que necesita el resumen (permite pasar
 *  filas de Prisma o literales en pruebas). */
export type IncidenciaConvertida = Omit<
  Incidencia,
  "dias" | "horas" | "horasTriples" | "monto"
> & {
  dias: number;
  horas: number | null;
  horasTriples: number | null;
  monto: number | null;
};

export type IncidenciaParaResumen = Pick<
  IncidenciaConvertida,
  "tipo" | "dias" | "horas" | "horasTriples" | "monto"
>;

/** ¿El resumen tiene algún efecto monetario sobre el cálculo? */
export function resumenTieneEfecto(r: IncidenciasResumen): boolean {
  return (
    r.diasFalta > 0 ||
    r.diasIncapacidad > 0 ||
    r.diasVacaciones > 0 ||
    r.horasExtraDobles > 0 ||
    r.horasExtraTriples > 0 ||
    r.bonos > 0 ||
    r.comisiones > 0 ||
    r.descuentos > 0
  );
}

/** Agrega las incidencias de UN empleado en el periodo al resumen que consume
 *  calcularNomina. Función pura — cubierta por pruebas doradas. */
export function resumirIncidencias(rows: IncidenciaParaResumen[]): IncidenciasResumen {
  const r: IncidenciasResumen = { ...RESUMEN_VACIO };
  for (const inc of rows) {
    switch (inc.tipo) {
      case "FALTA":
      case "FALTA_JUSTIFICADA":
      case "PERMISO_SIN_GOCE":
        r.diasFalta += Math.max(0, inc.dias);
        break;
      case "INCAPACIDAD":
        r.diasIncapacidad += Math.max(0, inc.dias);
        break;
      case "VACACIONES":
        r.diasVacaciones += Math.max(0, inc.dias);
        break;
      case "HORAS_EXTRA":
        r.horasExtraDobles += Math.max(0, inc.horas ?? 0);
        r.horasExtraTriples += Math.max(0, inc.horasTriples ?? 0);
        break;
      case "BONO":
        r.bonos += Math.max(0, inc.monto ?? 0);
        break;
      case "COMISION":
        r.comisiones += Math.max(0, inc.monto ?? 0);
        break;
      case "DESCUENTO":
        r.descuentos += Math.max(0, inc.monto ?? 0);
        break;
      // PERMISO_CON_GOCE y RETARDO: sin efecto monetario (documental).
      case "PERMISO_CON_GOCE":
      case "RETARDO":
        break;
    }
    r.numIncidencias++;
  }
  return r;
}

/**
 * Incidencias de un conjunto de empleados cuya FECHA cae dentro del periodo de
 * la corrida [inicio, fin] (inclusive), agrupadas por empleado. La liga
 * incidencia↔corrida es por fecha dentro del periodo — no hay FK a la corrida,
 * de modo que las incidencias capturadas ANTES de crear la corrida también se
 * toman en cuenta al calcular.
 */
export async function incidenciasDelPeriodo(
  companyId: string,
  employeeIds: string[],
  inicio: Date,
  fin: Date
): Promise<Map<string, IncidenciaConvertida[]>> {
  if (employeeIds.length === 0) return new Map();
  const rows = (
    await prisma.incidencia.findMany({
      where: {
        companyId,
        employeeId: { in: employeeIds },
        fecha: { gte: inicio, lte: fin },
      },
      orderBy: { fecha: "asc" },
    })
  ).map((r) => ({
    ...r,
    dias: Number(r.dias),
    horas: r.horas === null ? null : Number(r.horas),
    horasTriples: r.horasTriples === null ? null : Number(r.horasTriples),
    monto: r.monto === null ? null : Number(r.monto),
  }));
  const porEmpleado = new Map<string, IncidenciaConvertida[]>();
  for (const row of rows) {
    const list = porEmpleado.get(row.employeeId);
    if (list) list.push(row);
    else porEmpleado.set(row.employeeId, [row]);
  }
  return porEmpleado;
}

/** Rango de fechas [inicio, fin] de una corrida a partir de su campo `periodo`
 *  ("YYYY-MM-DD/YYYY-MM-DD"). El fin se extiende al final del día para que las
 *  incidencias fechadas ese día (guardadas a medianoche UTC) queden dentro. */
export function rangoDelPeriodo(periodo: string): { inicio: Date; fin: Date } | null {
  const [inicioStr, finStr] = periodo.split("/");
  if (!inicioStr || !finStr) return null;
  const inicio = new Date(inicioStr);
  const fin = new Date(finStr);
  if (isNaN(inicio.getTime()) || isNaN(fin.getTime())) return null;
  fin.setUTCHours(23, 59, 59, 999);
  return { inicio, fin };
}

/** Días naturales del periodo de una corrida (fallback para corridas creadas
 *  antes de que extraData.diasPagados se persistiera). */
export function diasDelPeriodo(periodo: string): number | null {
  const rango = rangoDelPeriodo(periodo);
  if (!rango) return null;
  const inicio = new Date(periodo.split("/")[0]);
  const fin = new Date(periodo.split("/")[1]);
  return Math.max(1, Math.round((fin.getTime() - inicio.getTime()) / 86400000) + 1);
}
