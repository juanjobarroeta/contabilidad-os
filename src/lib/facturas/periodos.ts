// ─────────────────────────────────────────────────────────────────────────────
// Selector de periodo de la pantalla de Facturas.
//
// La lista de CFDIs se cargaba SIEMPRE como "las 200 más recientes" sin ventana
// de fechas: en una empresa con volumen, todo lo anterior a esas 200 filas
// simplemente no existía para el usuario (caso real: no se veía nada antes del
// 16 de julio). Aquí vive la lógica PURA que convierte el conteo mensual que
// devuelve /api/facturas/resumen en las opciones del selector, y cada opción en
// la ventana [from, to] que ya entiende /api/facturas.
//
// Los límites del mes son UTC — los MISMOS que usa postMonth (posting.ts) para
// decidir a qué mes contable pertenece un CFDI. Así el mes que eliges aquí es
// exactamente el mes que se posteó al libro y el que se declara.
// ─────────────────────────────────────────────────────────────────────────────

/** Valor especial: sin ventana de fechas (todo el historial). */
export const PERIODO_TODO = "todo";

/** Conteo de comprobantes por mes, como lo devuelve /api/facturas/resumen. */
export interface ConteoPeriodo {
  /** "YYYY-MM" */
  periodo: string;
  total: number;
}

/** Un ejercicio con sus meses, para pintar la rejilla del selector. */
export interface EjercicioConteo {
  anio: number;
  /** Comprobantes del ejercicio completo. */
  total: number;
  /** Los 12 meses SIEMPRE, en orden natural; `total: 0` en los que no hubo
   *  nada. La rejilla los pinta apagados en vez de esconderlos: la posición
   *  fija de cada mes es lo que la hace escaneable de un vistazo. */
  meses: { periodo: string; mes: number; total: number }[];
}

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/** Abreviatura de tres letras para las celdas de la rejilla ("ene", "feb"…). */
export const MESES_CORTOS = MESES.map((m) => m.slice(0, 3));

const RE_MES = /^(\d{4})-(\d{2})$/;
const RE_ANIO = /^(\d{4})$/;

/** Etiqueta legible de un valor de periodo ("2026-07" → "julio 2026"). */
export function etiquetaPeriodo(valor: string): string {
  if (valor === PERIODO_TODO) return "Todo el historial";
  const mes = RE_MES.exec(valor);
  if (mes) {
    const m = Number(mes[2]);
    if (m >= 1 && m <= 12) return `${MESES[m - 1]} ${mes[1]}`;
    return valor;
  }
  const anio = RE_ANIO.exec(valor);
  if (anio) return `Todo ${anio[1]}`;
  return valor;
}

/**
 * Ventana [from, to] de un valor de periodo, en UTC y con `to` INCLUSIVO (el
 * último milisegundo del periodo) porque /api/facturas filtra con lte.
 * Devuelve null para "todo" o para un valor inválido — sin ventana, sin filtro.
 */
export function rangoPeriodo(valor: string): { from: Date; to: Date } | null {
  const mes = RE_MES.exec(valor);
  if (mes) {
    const y = Number(mes[1]);
    const m = Number(mes[2]);
    if (m < 1 || m > 12) return null;
    return {
      from: new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0)),
      to: new Date(Date.UTC(y, m, 1, 0, 0, 0, 0) - 1),
    };
  }
  const anio = RE_ANIO.exec(valor);
  if (anio) {
    const y = Number(anio[1]);
    return {
      from: new Date(Date.UTC(y, 0, 1, 0, 0, 0, 0)),
      to: new Date(Date.UTC(y + 1, 0, 1, 0, 0, 0, 0) - 1),
    };
  }
  return null;
}

/**
 * Agrupa los conteos mensuales por ejercicio, del más reciente al más antiguo,
 * rellenando SIEMPRE los 12 meses (con cero donde no hubo comprobantes) para
 * que la rejilla del selector tenga posiciones fijas.
 */
export function agruparPorEjercicio(conteos: ConteoPeriodo[]): EjercicioConteo[] {
  const porAnio = new Map<number, Map<number, number>>();
  for (const c of conteos) {
    const m = RE_MES.exec(c.periodo);
    if (!m || c.total <= 0) continue;
    const anio = Number(m[1]);
    const mes = Number(m[2]);
    if (mes < 1 || mes > 12) continue;
    const meses = porAnio.get(anio) ?? new Map<number, number>();
    meses.set(mes, (meses.get(mes) ?? 0) + c.total);
    porAnio.set(anio, meses);
  }

  return [...porAnio.keys()]
    .sort((a, b) => b - a)
    .map((anio) => {
      const meses = porAnio.get(anio)!;
      return {
        anio,
        total: [...meses.values()].reduce((s, n) => s + n, 0),
        meses: Array.from({ length: 12 }, (_, i) => ({
          periodo: `${anio}-${String(i + 1).padStart(2, "0")}`,
          mes: i + 1,
          total: meses.get(i + 1) ?? 0,
        })),
      };
    });
}

/** Total de comprobantes en todo el historial. */
export function totalComprobantes(conteos: ConteoPeriodo[]): number {
  return conteos
    .filter((c) => RE_MES.test(c.periodo) && c.total > 0)
    .reduce((s, c) => s + c.total, 0);
}
