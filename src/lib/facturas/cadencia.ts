// ─────────────────────────────────────────────────────────────────────────────
// Inferencia de CADENCIA: ¿esta forma de factura se repite con un ritmo?
//
// `agruparFacturasRecurrentes` ya sabe QUÉ formas repite la empresa (mismo
// cliente + mismos conceptos) y cuántas veces. Lo que tiraba eran las fechas:
// sabía que a ACME se le facturó 11 veces lo mismo, no que fue el día 1 de cada
// mes. Sin eso no se puede proponer automatizarlo.
//
// Este módulo mira sólo la lista de fechas de un grupo y decide si hay ritmo.
// Es PURO a propósito: proponer una serie recurrente equivocada le cuesta
// tiempo al usuario, así que la regla tiene que ser legible y probada, no una
// heurística escondida en una consulta.
//
// Postura: PRUDENTE. Preferimos no sugerir a sugerir de más — una sugerencia
// falsa en una pantalla de facturación erosiona la confianza en todas las demás.
// ─────────────────────────────────────────────────────────────────────────────

import { siguienteEmision, type Periodicidad } from "./recurrentes";

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Mínimo de facturas para hablar de un patrón.
 *
 * Con 2 fechas hay UN intervalo, y un intervalo no es un ritmo: son dos hechos
 * y una coincidencia. Con 3 hay dos intervalos que pueden confirmarse entre sí.
 */
export const MIN_OCURRENCIAS = 3;

/**
 * Bandas de tolerancia por periodicidad, en días. Anchas a propósito: nadie
 * factura exactamente cada 30 días — un mensual real oscila entre 28 y 31 según
 * el mes, y quien factura "el día 1" a veces lo hace el 2 o el 3.
 */
const BANDAS: { p: Periodicidad; min: number; max: number }[] = [
  { p: "SEMANAL", min: 5, max: 9 },
  { p: "MENSUAL", min: 25, max: 38 },
  { p: "BIMESTRAL", min: 52, max: 70 },
  { p: "TRIMESTRAL", min: 80, max: 102 },
  { p: "SEMESTRAL", min: 165, max: 200 },
  { p: "ANUAL", min: 340, max: 390 },
];

/**
 * Cuántos periodos de silencio antes de dar la serie por muerta.
 *
 * Una serie mensual cuya última factura fue hace ocho meses no es una serie
 * activa que convenga automatizar: es un cliente que se fue. Proponerla sería
 * invitar a facturarle a alguien que ya no compra.
 */
const PERIODOS_PARA_DARLA_POR_MUERTA = 3;

export type CadenciaDetectada = {
  periodicidad: Periodicidad;
  /** Día del mes al que se ancla la serie (la moda de los días observados). */
  diaMes: number;
  /** Cuántas facturas respaldan el patrón. */
  ocurrencias: number;
  /** Intervalo mediano observado, en días — para explicar el diagnóstico. */
  medianaDias: number;
  /** Fecha de la última factura de la serie. */
  ultima: Date;
  /** Próxima emisión esperada, con la misma regla de anclaje que el cron. */
  proxima: Date;
};

function mediana(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/**
 * Día del mes más repetido. Ante empate gana el MÁS ALTO, que es lo correcto
 * para el caso de "último día del mes": una serie que cae 31/28/31/30 tiene
 * cuatro días distintos, y quedarse con el 28 la anclaría al día equivocado.
 */
function modaDiaDelMes(fechas: Date[]): number {
  const conteo = new Map<number, number>();
  for (const f of fechas) {
    const d = f.getUTCDate();
    conteo.set(d, (conteo.get(d) ?? 0) + 1);
  }
  let mejorDia = fechas[fechas.length - 1].getUTCDate();
  let mejorConteo = 0;
  for (const [dia, n] of conteo) {
    if (n > mejorConteo || (n === mejorConteo && dia > mejorDia)) {
      mejorDia = dia;
      mejorConteo = n;
    }
  }
  return mejorDia;
}

/**
 * Infiere la cadencia de una lista de fechas de emisión. `null` cuando no hay
 * patrón defendible.
 *
 * Se exige que TODOS los intervalos caigan en la misma banda, no sólo la
 * mediana: doce facturas mensuales más una extraordinaria a mitad de mes dan
 * una mediana perfecta de 30 días y un ritmo que en realidad no existe. Si el
 * usuario factura de más fuera del ritmo, la serie automática le generaría
 * papel que no pidió.
 */
export function inferirCadencia(fechas: Date[], hoy: Date): CadenciaDetectada | null {
  if (fechas.length < MIN_OCURRENCIAS) return null;

  const orden = [...fechas].sort((a, b) => a.getTime() - b.getTime());

  const gaps: number[] = [];
  for (let i = 1; i < orden.length; i++) {
    const dias = Math.round((orden[i].getTime() - orden[i - 1].getTime()) / DIA_MS);
    // Dos facturas el mismo día no son un intervalo; son la misma emisión
    // partida en dos. Un gap de 0 haría colapsar cualquier mediana.
    if (dias <= 0) return null;
    gaps.push(dias);
  }

  const med = mediana(gaps);
  const banda = BANDAS.find((b) => med >= b.min && med <= b.max);
  if (!banda) return null;

  // Todos los intervalos dentro de la MISMA banda, no sólo la mediana.
  if (!gaps.every((g) => g >= banda.min && g <= banda.max)) return null;

  const ultima = orden[orden.length - 1];
  const silencio = Math.round((hoy.getTime() - ultima.getTime()) / DIA_MS);
  if (silencio > med * PERIODOS_PARA_DARLA_POR_MUERTA) return null;

  const diaMes = modaDiaDelMes(orden);

  return {
    periodicidad: banda.p,
    diaMes,
    ocurrencias: orden.length,
    medianaDias: med,
    ultima,
    // La MISMA función que usa el cron: lo que se propone es exactamente lo
    // que se generaría, incluido el recorte de fin de mes.
    proxima: siguienteEmision(ultima, banda.p, diaMes),
  };
}

/** "cada mes el día 1" / "cada semana" — el renglón de la sugerencia. */
export function describirCadencia(c: CadenciaDetectada): string {
  if (c.periodicidad === "SEMANAL") return "cada semana";
  const cada = {
    MENSUAL: "cada mes",
    BIMESTRAL: "cada 2 meses",
    TRIMESTRAL: "cada 3 meses",
    SEMESTRAL: "cada 6 meses",
    ANUAL: "cada año",
    SEMANAL: "cada semana",
  }[c.periodicidad];
  return `${cada} el día ${c.diaMes}`;
}
