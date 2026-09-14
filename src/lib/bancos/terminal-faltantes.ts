import { tarjetaDeLiquidacion, type TipoTarjeta } from "./terminal";

// ─────────────────────────────────────────────────────────────────────────────
// QUÉ LE FALTA A LA TERMINAL PARA PODERSE AUDITAR. PURO.
//
// El sistema ya reconoce una liquidación de terminal por el sufijo de la
// afiliación (`terminal.ts`). Lo que nunca hizo fue sacar la conclusión que
// sigue: si en un mes hay liquidaciones de terminal y nadie cargó el estado de
// cuenta de esa terminal, ese mes NO se puede auditar — no se sabe qué ventas
// componen cada lote ni cuánto cobró el adquirente de comisión.
//
// Eso pasó de verdad: un centro de procedimientos con depósitos de terminal que
// hubo que reconstruir a mano porque el estado de cuenta nunca se pidió. El
// sistema tenía todas las piezas para saberlo y ningún lugar donde decirlo.
//
// Aquí se saca la conclusión; abrir la solicitud es de `solicitudes/`.
// ─────────────────────────────────────────────────────────────────────────────

/** Afiliación seguida del sufijo de tarjeta: el número identifica la terminal. */
const RE_AFILIACION_NUM = /\b(\d{7,})([CD])\b/;

/**
 * El número de afiliación de una liquidación de terminal. PURA.
 *
 * `tarjetaDeLiquidacion` responde QUÉ tarjeta; esto responde DE QUÉ TERMINAL.
 * Hacen falta las dos: una empresa puede tener varias terminales y el estado de
 * cuenta se pide por afiliación, no por empresa.
 */
export function afiliacionDeLiquidacion(descripcion: string): string | null {
  const m = RE_AFILIACION_NUM.exec(descripcion ?? "");
  return m ? m[1] : null;
}

export interface MovimientoTerminal {
  id: string;
  fecha: Date;
  descripcion: string;
  monto: number;
}

export interface LoteTerminal {
  /** "YYYY-MM" del movimiento. */
  periodo: string;
  afiliacion: string;
  tarjeta: TipoTarjeta | null;
  movimientos: string[];
  /** Cuánto depositó el banco por esa afiliación en ese mes. */
  total: number;
}

/** "YYYY-MM" de una fecha, en UTC (las fechas bancarias son días, no instantes). */
export function periodoDe(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Agrupa las liquidaciones de terminal por mes y afiliación. PURA.
 *
 * Se agrupa por AFILIACIÓN y no sólo por mes porque el estado de cuenta se pide
 * por terminal: una empresa con dos terminales que sólo carga una sigue sin
 * poder auditar la otra, y un aviso a nivel empresa lo ocultaría.
 *
 * Las dos tarjetas de una misma afiliación caen en el mismo lote: el banco
 * liquida por separado crédito y débito, pero el estado de cuenta que hay que
 * pedir es uno solo.
 */
export function lotesDeTerminal(movimientos: MovimientoTerminal[]): LoteTerminal[] {
  const por = new Map<string, LoteTerminal>();
  for (const m of movimientos) {
    const afiliacion = afiliacionDeLiquidacion(m.descripcion);
    if (!afiliacion) continue;
    const periodo = periodoDe(m.fecha);
    const k = `${periodo}|${afiliacion}`;
    const previo = por.get(k);
    if (previo) {
      previo.movimientos.push(m.id);
      previo.total += Math.abs(m.monto);
      // Una afiliación con lotes de las dos tarjetas no es «de crédito» ni «de
      // débito»: decirlo sería inventar precisión que el lote no tiene.
      const t = tarjetaDeLiquidacion(m.descripcion);
      if (previo.tarjeta && t && previo.tarjeta !== t) previo.tarjeta = null;
      continue;
    }
    por.set(k, {
      periodo,
      afiliacion,
      tarjeta: tarjetaDeLiquidacion(m.descripcion),
      movimientos: [m.id],
      total: Math.abs(m.monto),
    });
  }
  return [...por.values()].sort(
    (a, b) => b.periodo.localeCompare(a.periodo) || a.afiliacion.localeCompare(b.afiliacion),
  );
}

/**
 * La llave que identifica el hueco. PURA.
 *
 * Es lo que impide que la corrida diaria abra la misma solicitud cada mañana:
 * mismo mes y misma afiliación son el mismo pedido, aunque el mes siga creciendo
 * en movimientos.
 */
export function llaveDeFaltante(periodo: string, afiliacion: string): string {
  return `terminal:${periodo}:${afiliacion}`;
}

export interface FaltanteTerminal extends LoteTerminal {
  dedupeKey: string;
  detalle: string;
}

const money = (n: number) => `$${n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Los lotes que NO tienen estado de cuenta de terminal cargado. PURA.
 *
 * `resueltos` son las llaves de los periodos/afiliaciones cuyo estado de cuenta
 * ya llegó (o cuyo pedido se canceló a propósito). Se pasan de fuera para que
 * esta función no sepa de la base.
 *
 * El mes EN CURSO se excluye: el adquirente todavía no lo ha cerrado, así que
 * pedirlo sería pedir algo que el cliente no puede dar — y un pedido imposible
 * enseña a ignorar los pedidos.
 */
export function faltantesDeTerminal(
  lotes: LoteTerminal[],
  resueltos: ReadonlySet<string>,
  hoy: Date,
): FaltanteTerminal[] {
  const enCurso = periodoDe(hoy);
  return lotes
    .filter((l) => l.periodo < enCurso)
    .map((l) => ({
      ...l,
      dedupeKey: llaveDeFaltante(l.periodo, l.afiliacion),
      detalle: `El banco depositó ${money(l.total)} en ${l.movimientos.length} ${l.movimientos.length === 1 ? "liquidación" : "liquidaciones"} de la afiliación ${l.afiliacion}.`,
    }))
    .filter((l) => !resueltos.has(l.dedupeKey));
}
