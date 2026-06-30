// ─────────────────────────────────────────────────────────────────────────────
// Proyección de declaración mensual — nudge PROACTIVO antes del día 17.
//
// Lógica PURA (sin DB/IO) para poder probar las marcas T-7 y T-3 de forma
// aislada. El periodo "en juego" es el mes natural anterior al de `hoy` (en
// cualquier día de julio se está por declarar JUNIO, que vence el 17 de julio).
//
// Se empuja la proyección de cifras (IVA/ISR estimados) dos veces antes del
// vencimiento: a 7 días y a 3 días. La presentación real ante el SAT sigue
// siendo manual — esto sólo proyecta + avisa para que el usuario revise/apruebe.
// ─────────────────────────────────────────────────────────────────────────────

import { getObligacionesPorRegimen, nextBusinessDay } from "@/lib/obligaciones";

/** Día legal de vencimiento de las obligaciones mensuales (IVA/ISR/DIOT). */
const DIA_VENCIMIENTO = 17;

/** Marcas (en días naturales antes del vencimiento) en las que se proyecta. */
export const MARCA_T7 = 7;
export const MARCA_T3 = 3;

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

const MS_POR_DIA = 24 * 60 * 60 * 1000;

function inicioDelDia(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export interface VencimientoMensual {
  /** Periodo en juego (mes que se está por declarar), formato "YYYY-MM". */
  periodo: string;
  /** Año del periodo en juego. */
  year: number;
  /** Mes (1-12) del periodo en juego. */
  month: number;
  /** Nombre del mes del periodo en juego, en minúsculas ("junio"). */
  mesNombre: string;
  /** Fecha de vencimiento (día 17 hábil del mes natural siguiente al periodo). */
  vencimiento: Date;
  /** Días naturales desde `hoy` hasta el vencimiento (negativo si ya pasó). */
  dias: number;
}

/**
 * Días hasta el vencimiento mensual MÁS PRÓXIMO y el periodo que se está por
 * declarar. PURA: no toca DB. Devuelve null si el régimen no tiene obligaciones
 * mensuales (p. ej. RIF bimestral o "Sin Obligaciones").
 *
 * El periodo en juego es el mes natural anterior al de `hoy`; su vencimiento es
 * el día 17 (hábil) del mes de `hoy`. La cuenta de días usa el vencimiento HÁBIL
 * (corrido a lunes/posterior si el 17 cae en fin de semana o feriado SAT), igual
 * que el resto del sistema.
 */
export function diasParaVencimientoMensual(
  regimen: string,
  hoy: Date = new Date(),
): VencimientoMensual | null {
  const obligaciones = getObligacionesPorRegimen(regimen);
  const tieneMensual = obligaciones.some((o) => o.periodicidad === "MENSUAL");
  if (!tieneMensual) return null;

  // Mes natural anterior al de hoy (1-based), ajustando el cruce de año.
  let year = hoy.getFullYear();
  let month = hoy.getMonth(); // getMonth() es 0-based ⇒ mes natural anterior en 1-based.
  if (month === 0) {
    month = 12;
    year -= 1;
  }

  // Vencimiento = día 17 del mes natural siguiente al periodo (= mes de hoy),
  // corrido al siguiente día hábil.
  const vencRaw = new Date(hoy.getFullYear(), hoy.getMonth(), DIA_VENCIMIENTO);
  const vencimiento = nextBusinessDay(vencRaw);

  const dias = Math.round(
    (inicioDelDia(vencimiento).getTime() - inicioDelDia(hoy).getTime()) / MS_POR_DIA,
  );

  return {
    periodo: `${year}-${String(month).padStart(2, "0")}`,
    year,
    month,
    mesNombre: MESES[month - 1],
    vencimiento,
    dias,
  };
}

/**
 * ¿Toca enviar la proyección hoy? Verdadero en las marcas T-7 y T-3 antes del
 * vencimiento. Cada marca usa una ventana de UN día (exactamente 7 y exactamente
 * 3) para que, corriendo a diario, dispare ~dos veces por periodo sin spamear.
 * Devuelve la marca alcanzada (7 o 3) o null si no toca.
 */
export function debeEnviarProyeccion(dias: number): 7 | 3 | null {
  if (dias === MARCA_T7) return MARCA_T7;
  if (dias === MARCA_T3) return MARCA_T3;
  return null;
}

export interface ProyeccionCifras {
  ivaPagar: number;
  ivaSaldoAFavor: number;
  isrPagar: number | null;
}

/**
 * Compone el cuerpo del aviso de proyección. PURA — recibe ya las cifras
 * calculadas (de computeTaxPosition) para poder probar la redacción sin DB.
 * `complementosFaltantes` es opcional; si es > 0 se menciona el número de
 * complementos de pago (PPD) sin REP que cuestan IVA acreditable.
 */
export function componerMensajeProyeccion(
  mesNombre: string,
  cifras: ProyeccionCifras,
  complementosFaltantes?: number,
): string {
  const fmt = (n: number) =>
    new Intl.NumberFormat("es-MX", {
      style: "currency",
      currency: "MXN",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(n);

  const partes: string[] = [];
  if (cifras.ivaSaldoAFavor > 0) {
    partes.push(`IVA a favor ~${fmt(cifras.ivaSaldoAFavor)}`);
  } else {
    partes.push(`IVA ~${fmt(cifras.ivaPagar)}`);
  }
  if (cifras.isrPagar != null) {
    partes.push(`ISR ~${fmt(cifras.isrPagar)}`);
  }

  let cuerpo = `Proyección de ${mesNombre}: ${partes.join(", ")}.`;
  if (complementosFaltantes && complementosFaltantes > 0) {
    cuerpo += ` Faltan ${complementosFaltantes} complemento${complementosFaltantes === 1 ? "" : "s"} de pago.`;
  }
  cuerpo += " Revisa y aprueba.";
  return cuerpo;
}

/** Mes capitalizado para el título del aviso ("Junio"). */
export function mesNombreCapitalizado(mesNombre: string): string {
  return mesNombre.charAt(0).toUpperCase() + mesNombre.slice(1);
}
