// ─────────────────────────────────────────────────────────────────────────────
// ¿El mes que marcamos «hecho» realmente trajo las facturas?
//
// sat-backfill marca un periodo hecho cuando las dos solicitudes (emitidos y
// recibidos) llegan a FINISHED — sin mirar cuántas facturas entraron. Así se
// quedaron ocho meses de MARGOM: pedidos, FINISHED, casi vacíos, y «hechos»
// para siempre. ~$500M de ingreso y ~5,200 facturas que nunca entraron, y las
// unidades vendidas en esos meses jamás se dieron de baja.
//
// El SAT ya nos dice cuántos CFDIs encontró: `SatSyncRequest.cfdisFound`, que
// sale de `verifyResult.getNumberCfdis()`. Comparar eso contra lo que tenemos
// en la base es una verificación REAL, no una heurística de vecinos.
//
// LO QUE NO SE COMPARA: `cfdisFound` contra `imported`. `imported` cuenta
// inserciones NUEVAS (el import dedup por UUID), así que un mes sano que se
// vuelve a verificar reporta imported=0 con cfdisFound=800 — y el mes se vería
// roto para siempre, re-pidiéndose en cada corrida. Se compara contra las
// facturas que REALMENTE tenemos del periodo, que es la pregunta de fondo y
// además es estable entre corridas.
//
// DETECTAR NO ES REINTENTAR. Un mes con la cuota 5002 quemada no se puede
// rellenar por la vía mensual: reintentarlo solo, en automático, gastaría el
// presupuesto de solicitudes de cada corrida sin traer nada. Así que esto NO
// desmarca el periodo — lo REPORTA, y rellenarlo es un acto deliberado con
// `sat-repesca` (que pide el mes en tramos, otra llave de cuota).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Qué fracción de lo que el SAT dijo tener basta para considerar el mes cubierto.
 *
 * Deliberadamente flojo: no se busca cuadrar al CFDI —los conteos no son
 * comparables al uno (la solicitud de recibidos filtra `active`, la de emitidos
 * no, y las canceladas entran y salen)— sino cachar faltantes GROSEROS, del
 * tamaño de «el SAT dijo 800 y tenemos 3».
 */
export const UMBRAL_COBERTURA = 0.5;

/** Un mes sin CFDIs es normal (empresa nueva, mes muerto): 5004 no es un error. */
export interface CoberturaPeriodo {
  year: number;
  month: number;
  /** Suma de cfdisFound de las solicitudes del periodo (emitidos + recibidos). */
  satDijo: number;
  /** Facturas que tenemos en la base de ese periodo. */
  tenemos: number;
}

export interface Sospecha extends CoberturaPeriodo {
  periodo: string;
  /** Cuántas faltan, cuando menos. */
  faltanCuandoMenos: number;
  cobertura: number;
}

const clave = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;

/**
 * ¿Este periodo trajo una fracción plausible de lo que el SAT dijo tener?
 *
 * `satDijo === 0` NO es sospechoso: el SAT contestó 5004 («sin CFDIs en este
 * período») y eso puede ser la verdad. Lo sospechoso es que dijera que hay y no
 * los tengamos.
 */
export function esCoberturaSospechosa(p: CoberturaPeriodo, umbral = UMBRAL_COBERTURA): boolean {
  if (p.satDijo <= 0) return false;
  return p.tenemos < p.satDijo * umbral;
}

/**
 * ¿Este periodo ya terminó?
 *
 * El mes EN CURSO está a medio ingerir por definición: el SAT reporta lo que
 * lleva y nosotros vamos detrás. Medido el 2026-08-14, MARGOM salió con
 * satDijo=6,894 y tenemos=2,087 (30%) — y no le falta nada, le faltan 17 días.
 * Marcarlo sospechoso manda a repescar un mes que se está llenando solo, y peor:
 * gasta cuota vitalicia en un rango que de todos modos hay que volver a pedir.
 */
export function periodoCerrado(p: { year: number; month: number }, hoy: Date): boolean {
  const anioHoy = hoy.getUTCFullYear();
  const mesHoy = hoy.getUTCMonth() + 1;
  return p.year < anioHoy || (p.year === anioHoy && p.month < mesHoy);
}

/** Los periodos que el SAT dijo tener y nosotros no. Ordenados por hueco. */
export function coberturaSospechosa(
  periodos: CoberturaPeriodo[],
  umbral = UMBRAL_COBERTURA,
  hoy = new Date(),
): Sospecha[] {
  return periodos
    .filter((p) => periodoCerrado(p, hoy) && esCoberturaSospechosa(p, umbral))
    .map((p) => ({
      ...p,
      periodo: clave(p.year, p.month),
      faltanCuandoMenos: p.satDijo - p.tenemos,
      cobertura: Math.round((p.tenemos / p.satDijo) * 10000) / 10000,
    }))
    .sort((a, b) => b.faltanCuandoMenos - a.faltanCuandoMenos);
}

// ─── Lo que el SAT dijo tener, sin contar dos veces ──────────────────────────
//
// Cada solicitud guarda el rango EXACTO que se pidió. Durante el mes, sat-sync
// pide «del 1 a ayer» cada día: 1→2, 1→3, … 1→30 — rangos distintos que se
// enciman. Agrupar por rango distinto y sumar contaba septiembre ~10 veces
// (medido 2026-10-02: AMA «el SAT dijo 55,984, tenemos 5,457»; CPM 10,078 vs
// 959 — todas las empresas en ~10%). Lo correcto es la UNIÓN de los rangos:
// por (mes, tipo) se toman rangos que no se enciman, empezando por el más
// amplio, y sólo ésos suman. Los tramos de una repesca son disjuntos y suman;
// el mes completo cubre a sus tramos y se cuenta una vez.

export interface SolicitudConteo {
  year: number;
  month: number;
  tipo: string;
  status: string;
  desde: Date | string | null;
  hasta: Date | string | null;
  cfdisFound: number;
  createdAt: Date | string;
}

const ms = (d: Date | string) => new Date(d).getTime();

/** Por mes («y-m», mes sin cero): CFDIs que el SAT reportó en la unión de los rangos pedidos (emitidos + recibidos). */
export function satDijoSinSolapes(solicitudes: SolicitudConteo[]): Map<string, number> {
  // La más reciente por (mes, tipo, rango).
  const ultima = new Map<string, SolicitudConteo & { d: number; h: number }>();
  for (const s of solicitudes) {
    if (s.status !== "FINISHED" || (s.tipo !== "EMITIDOS" && s.tipo !== "RECIBIDOS")) continue;
    // Filas viejas sin rango = el mes completo.
    const d = s.desde ? ms(s.desde) : Date.UTC(s.year, s.month - 1, 1);
    const h = s.hasta ? ms(s.hasta) : Date.UTC(s.year, s.month, 0, 23, 59, 59);
    const k = `${s.year}|${s.month}|${s.tipo}|${d}|${h}`;
    const prev = ultima.get(k);
    if (!prev || ms(s.createdAt) > ms(prev.createdAt)) ultima.set(k, { ...s, d, h });
  }
  const porMesTipo = new Map<string, Array<SolicitudConteo & { d: number; h: number }>>();
  for (const s of ultima.values()) {
    const k = `${s.year}|${s.month}|${s.tipo}`;
    porMesTipo.set(k, [...(porMesTipo.get(k) ?? []), s]);
  }
  const out = new Map<string, number>();
  // Suma de una selección de rangos que no se enciman (codicioso en el orden dado).
  const sinEncimar = (filas: Array<{ d: number; h: number; cfdisFound: number }>) => {
    let hastaTomado = -Infinity;
    let suma = 0;
    for (const f of filas) {
      if (f.d <= hastaTomado) continue;
      suma += f.cfdisFound;
      hastaTomado = f.h;
    }
    return suma;
  };
  for (const filas of porMesTipo.values()) {
    // Dos selecciones válidas (ninguna cuenta un día dos veces); gana la mayor:
    //  - los rangos más amplios primero: «del 1 a ayer» repetido → el último;
    //  - los que terminan antes primero: los tramos de una repesca, que
    //    re-pidieron el mes porque el conteo completo no cuadraba.
    const amplios = sinEncimar([...filas].sort((a, b) => a.d - b.d || b.h - a.h));
    const tramos = sinEncimar([...filas].sort((a, b) => a.h - b.h || b.d - a.d));
    const k = `${filas[0].year}-${filas[0].month}`;
    out.set(k, (out.get(k) ?? 0) + Math.max(amplios, tramos));
  }
  return out;
}
