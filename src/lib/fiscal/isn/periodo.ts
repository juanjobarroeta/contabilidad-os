// ─────────────────────────────────────────────────────────────────────────────
// ISN del periodo — el impuesto sobre nóminas como OBLIGACIÓN, no como hallazgo.
//
// El cálculo existía desde hace tiempo (`calc.ts`: tasa por entidad, con su ley
// y su artículo) pero sólo alimentaba al auditor. No había tipo de declaración,
// ni fecha límite, ni renglón en el total del mes: un impuesto que la app
// calculaba y enseguida olvidaba. Para una empresa con nómina son entre el 2 %
// y el 4 % de lo que paga, cada mes, a la tesorería de su estado.
//
// DOS COSAS QUE ESTE MÓDULO NO HACE, A PROPÓSITO:
//
// 1. NO suma un estado cuya tasa no está en el catálogo. Un total incompleto
//    que parece completo es peor que un total que dice qué le falta, así que
//    esas entidades salen aparte en `sinTasa` y el contador las ve.
//
// 2. NO promete exactitud donde el estado no es de tasa plana. Sinaloa es
//    progresivo por tramos, Sonora cobra 1 % adicional arriba de 100
//    trabajadores, Yucatán y Zacatecas traen sobretasa: en esos casos la cifra
//    es una ESTIMACIÓN con la tasa general y así viaja, en `aproximadas`.
//
// El vencimiento es el día 17 del mes siguiente en día hábil, que es el más
// extendido; los estados que difieren se irán afinando con su regla propia.
// ─────────────────────────────────────────────────────────────────────────────

import { calcularVencimiento } from "@/lib/obligaciones";
import type { Entidad } from "../rules";
import type { ResumenIsn } from "./types";

/** Día de vencimiento más extendido del ISN estatal. */
export const DIA_VENCIMIENTO_ISN = 17;

export interface EntidadAproximada {
  entidad: Entidad;
  nota: string;
}

export interface PeriodoIsn {
  /** "YYYY-MM". */
  periodo: string;
  fechaLimite: Date;
  /** Suma SÓLO de las entidades con tasa conocida. */
  total: number;
  /** Entidades con tasa: lo que se declara, con su fundamento. */
  porEntidad: ResumenIsn["porEntidad"];
  /** Entidades con nómina y SIN tasa en el catálogo: no entran en `total`. */
  sinTasa: Entidad[];
  /** Entidades cuya cifra es estimada (progresivo o sobretasa). */
  aproximadas: EntidadAproximada[];
  /** Empleados activos sin entidad válida: su nómina no se pudo atribuir. */
  empleadosSinEntidad: number;
  /** "payroll" = nómina real del mes; "estimado" = del salario diario. */
  fuente: ResumenIsn["fuente"];
  /** true cuando NINGUNA tasa del periodo está verificada contra texto primario. */
  todasSinVerificar: boolean;
}

/**
 * Arma el periodo de ISN desde un resumen ya calculado. PURA — toda la
 * aritmética y todas las salvedades se deciden aquí, sin tocar la base.
 */
export function periodoIsn(year: number, month: number, resumen: ResumenIsn): PeriodoIsn {
  const periodo = `${year}-${String(month).padStart(2, "0")}`;
  const fechaLimite = calcularVencimiento(
    {
      tipo: "ISN_MENSUAL",
      descripcion: "ISN (impuesto sobre nóminas)",
      periodicidad: "MENSUAL",
      diaVencimiento: DIA_VENCIMIENTO_ISN,
    },
    periodo,
  );

  const conTasa = resumen.porEntidad.filter((e) => e.tasa !== null && e.isn !== null);
  const sinTasa = resumen.porEntidad.filter((e) => e.tasa === null).map((e) => e.entidad);
  const aproximadas = conTasa
    .filter((e) => e.nota)
    .map((e) => ({ entidad: e.entidad, nota: e.nota as string }));

  return {
    periodo,
    fechaLimite,
    total: Math.round(conTasa.reduce((s, e) => s + (e.isn ?? 0), 0) * 100) / 100,
    porEntidad: conTasa,
    sinTasa,
    aproximadas,
    empleadosSinEntidad: resumen.empleadosSinEntidad,
    fuente: resumen.fuente,
    // Las tasas del catálogo llevan `verificado: false` hasta cotejarse contra
    // el texto de la ley estatal. Decirlo es parte del número.
    todasSinVerificar: conTasa.length > 0 && conTasa.every((e) => !e.verificado),
  };
}

/** ¿Esta empresa causa ISN este mes? Sin nómina atribuible, no hay obligación. */
export function causaIsn(p: PeriodoIsn): boolean {
  return p.porEntidad.length > 0 || p.sinTasa.length > 0;
}
