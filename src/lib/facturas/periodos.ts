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

/** Una opción del selector: todo el historial, un ejercicio o un mes. */
export interface OpcionPeriodo {
  /** "todo" | "YYYY" | "YYYY-MM" */
  valor: string;
  etiqueta: string;
  total: number;
  /** Sangrado en el <select>: los meses cuelgan de su ejercicio. */
  nivel: 0 | 1;
}

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

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
 * Opciones del selector a partir de los meses QUE SÍ TIENEN comprobantes: "todo
 * el historial", y por cada ejercicio (del más reciente al más antiguo) el año
 * completo seguido de sus meses. Nunca ofrece un mes vacío — si aparece en la
 * lista, hay algo que ver.
 */
export function opcionesPeriodo(conteos: ConteoPeriodo[]): OpcionPeriodo[] {
  const validos = conteos.filter((c) => RE_MES.test(c.periodo) && c.total > 0);
  const total = validos.reduce((s, c) => s + c.total, 0);

  const porAnio = new Map<string, ConteoPeriodo[]>();
  for (const c of validos) {
    const anio = c.periodo.slice(0, 4);
    const lista = porAnio.get(anio) ?? [];
    lista.push(c);
    porAnio.set(anio, lista);
  }

  const opciones: OpcionPeriodo[] = [
    { valor: PERIODO_TODO, etiqueta: etiquetaPeriodo(PERIODO_TODO), total, nivel: 0 },
  ];
  const anios = [...porAnio.keys()].sort().reverse();
  for (const anio of anios) {
    const meses = (porAnio.get(anio) ?? []).slice().sort((a, b) => b.periodo.localeCompare(a.periodo));
    opciones.push({
      valor: anio,
      etiqueta: etiquetaPeriodo(anio),
      total: meses.reduce((s, c) => s + c.total, 0),
      nivel: 0,
    });
    for (const m of meses) {
      opciones.push({ valor: m.periodo, etiqueta: etiquetaPeriodo(m.periodo), total: m.total, nivel: 1 });
    }
  }
  return opciones;
}
