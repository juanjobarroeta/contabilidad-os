// ─────────────────────────────────────────────────────────────────────────────
// ISN del periodo — el impuesto sobre nóminas como OBLIGACIÓN, no como hallazgo,
// y UNA POR ESTADO.
//
// El cálculo existía desde hace tiempo (`calc.ts`: tasa por entidad, con su ley
// y su artículo) pero sólo alimentaba al auditor. No había tipo de declaración,
// ni fecha límite, ni renglón en el mes: un impuesto que la app calculaba y
// enseguida olvidaba. Para una empresa con nómina son entre el 2 % y el 4 % de
// lo que paga, cada mes.
//
// SE DECLARA Y SE PAGA POR ESTADO. Una empresa con nómina en Oaxaca y en Nuevo
// León tiene DOS obligaciones, ante dos tesorerías, con dos fechas y dos
// portales. Por eso esto devuelve una obligación por entidad y no un total:
// juntarlas impediría decir «Oaxaca ya, Nuevo León pendiente», que es
// exactamente lo que un despacho necesita decir.
//
// DOS COSAS QUE NO HACE, A PROPÓSITO:
//
// 1. NO inventa la nómina de un estado cuya tasa no está en el catálogo: esa
//    entidad sale como obligación SIN IMPORTE, con su base y su advertencia. El
//    contador ve que existe y que falta el dato — que no es lo mismo que cero.
//
// 2. NO promete exactitud donde el estado no es de tasa plana. Sinaloa es
//    progresivo por tramos, Sonora cobra 1 % adicional arriba de 100
//    trabajadores, Yucatán y Zacatecas traen sobretasa: ahí la cifra es una
//    ESTIMACIÓN con la tasa general, y viaja diciéndolo.
// ─────────────────────────────────────────────────────────────────────────────

import { calcularVencimiento } from "@/lib/obligaciones";
import { getRule, type Contexto, type Entidad, type Fundamento } from "../rules";
import type { ResumenIsn } from "./types";

/**
 * Día de vencimiento cuando el estado no tiene el suyo cotejado en el catálogo.
 * El 17 es el más extendido; los que difieren se cargan en `isn.dia_vencimiento`
 * por PR revisado, igual que las tasas.
 */
export const DIA_VENCIMIENTO_ISN_DEFAULT = 17;

/** La obligación de ISN de UNA entidad. */
export interface ObligacionIsn {
  entidad: Entidad;
  numEmpleados: number;
  /** Remuneraciones gravables del mes en ese estado. */
  baseMensual: number;
  /** Tasa general del estado; null si el catálogo no la tiene. */
  tasa: number | null;
  /** base × tasa; null cuando no hay tasa — NO es cero. */
  importe: number | null;
  fechaLimite: Date;
  /** false = el día salió del default, no de la ley de ese estado. */
  vencimientoVerificado: boolean;
  /** false = la tasa no se ha cotejado contra el texto publicado. */
  tasaVerificada: boolean;
  /** Progresivo, sobretasa, estímulos: la cifra es aproximada. */
  nota?: string;
  fundamento?: Fundamento;
}

export interface PeriodoIsn {
  /** "YYYY-MM". */
  periodo: string;
  /** Una obligación por estado con nómina, con o sin tasa conocida. */
  obligaciones: ObligacionIsn[];
  /** Suma de las que SÍ tienen tasa. Nunca incluye las que no. */
  totalConocido: number;
  /** Estados con nómina y sin tasa: hay obligación, falta la cifra. */
  sinTasa: Entidad[];
  /** Empleados activos sin entidad válida: su nómina no se pudo atribuir. */
  empleadosSinEntidad: number;
  /** "payroll" = nómina real del mes; "estimado" = del salario diario. */
  fuente: ResumenIsn["fuente"];
}

/** Día de vencimiento de un estado: el suyo si está cotejado, si no el default. */
export function diaVencimientoDe(
  entidad: Entidad,
  ctxBase: Contexto,
): { dia: number; verificado: boolean } {
  const regla = getRule<number>("isn.dia_vencimiento", { ...ctxBase, entidad });
  return regla ? { dia: regla.valor, verificado: true } : { dia: DIA_VENCIMIENTO_ISN_DEFAULT, verificado: false };
}

/**
 * Arma las obligaciones de ISN del mes desde un resumen ya calculado. PURA —
 * toda la aritmética y todas las salvedades se deciden aquí.
 */
export function periodoIsn(
  year: number,
  month: number,
  resumen: ResumenIsn,
  ctxBase: Contexto,
): PeriodoIsn {
  const periodo = `${year}-${String(month).padStart(2, "0")}`;

  const obligaciones: ObligacionIsn[] = resumen.porEntidad.map((e) => {
    const { dia, verificado } = diaVencimientoDe(e.entidad, ctxBase);
    return {
      entidad: e.entidad,
      numEmpleados: e.numEmpleados,
      baseMensual: e.baseMensual,
      tasa: e.tasa,
      importe: e.isn,
      fechaLimite: calcularVencimiento(
        {
          tipo: "ISN_MENSUAL",
          descripcion: `ISN ${e.entidad}`,
          periodicidad: "MENSUAL",
          diaVencimiento: dia,
        },
        periodo,
      ),
      vencimientoVerificado: verificado,
      tasaVerificada: e.verificado,
      nota: e.nota,
      fundamento: e.fundamento,
    };
  });

  // Orden estable y útil: primero lo que vence antes, y a igual fecha lo grande.
  obligaciones.sort(
    (a, b) =>
      a.fechaLimite.getTime() - b.fechaLimite.getTime() ||
      (b.importe ?? 0) - (a.importe ?? 0) ||
      a.entidad.localeCompare(b.entidad),
  );

  return {
    periodo,
    obligaciones,
    totalConocido:
      Math.round(obligaciones.reduce((s, o) => s + (o.importe ?? 0), 0) * 100) / 100,
    sinTasa: obligaciones.filter((o) => o.tasa === null).map((o) => o.entidad),
    empleadosSinEntidad: resumen.empleadosSinEntidad,
    fuente: resumen.fuente,
  };
}

/** ¿Esta empresa causa ISN este mes? Sin nómina atribuible, no hay obligación. */
export function causaIsn(p: PeriodoIsn): boolean {
  return p.obligaciones.length > 0;
}
