// ─────────────────────────────────────────────────────────────────────────────
// AGAPES — exención anual (Art. 74 LISR). Computed in múltiplos de UMA anual,
// resolved from the rules layer (uma.valor + agapes.exencion.*). PF: 40 UMA.
// PM: 20 UMA por socio, tope 200 UMA. The ISR engine consumes `exencionMXN` to
// reduce the gravable base — this module only computes the exempt amount.
// ─────────────────────────────────────────────────────────────────────────────

import { getRule, type Contexto, type Tabla } from "./rules";

export interface ExencionAgapes {
  /** Monto exento en el ejercicio, MXN. */
  exencionMXN: number;
  /** UMA anual usada. */
  umaAnual: number;
  /** Factor efectivo en UMA (ya con tope/socios aplicados). */
  factorUMA: number;
  /** Tope en UMA (solo PM). */
  topeUMA?: number;
  /** Socios considerados (solo PM). */
  socios?: number;
  fundamento: { ley: string; articulo: string; fraccion?: string };
  /** True solo si tanto la UMA como el factor están verificados. */
  verificado: boolean;
}

/**
 * Exención anual de AGAPES para el contexto. Devuelve null si la empresa no es
 * AGAPES (no hay regla aplicable) o si no se resuelve la UMA. Para PM pasa el
 * número de socios en `opts.socios` (default 1).
 */
export function exencionAgapesAnual(
  ctx: Contexto,
  opts?: { socios?: number },
): ExencionAgapes | null {
  const uma = getRule<Tabla>("uma.valor", ctx);
  const factor = getRule<number>("agapes.exencion.factor_uma_anual", ctx);
  if (!uma || !factor) return null; // no AGAPES, o sin UMA vigente

  const umaAnual = uma.valor.anual;

  if (ctx.tipoPersona === "PM") {
    const socios = Math.max(1, Math.floor(opts?.socios ?? 1));
    const tope = getRule<number>("agapes.exencion.tope_uma_anual", ctx);
    const topeUMA = tope?.valor;
    let factorUMA = factor.valor * socios;
    if (topeUMA !== undefined) factorUMA = Math.min(factorUMA, topeUMA);
    return {
      exencionMXN: Math.round(factorUMA * umaAnual * 100) / 100,
      umaAnual,
      factorUMA,
      topeUMA,
      socios,
      fundamento: factor.fundamento,
      verificado: uma.verificado && factor.verificado && (tope?.verificado ?? true),
    };
  }

  // PF: 40 UMA anuales, sin tope por socios.
  const factorUMA = factor.valor;
  return {
    exencionMXN: Math.round(factorUMA * umaAnual * 100) / 100,
    umaAnual,
    factorUMA,
    fundamento: factor.fundamento,
    verificado: uma.verificado && factor.verificado,
  };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface ReduccionIsrAgapes {
  /** ISR después de la reducción, MXN. */
  isrReducido: number;
  /** Monto reducido, MXN. */
  reduccionMXN: number;
  /** Fracción de reducción (0.30). */
  reduccionPct: number;
  /** Límite de ingresos anuales que conserva la reducción, en MXN (UMA × límite). */
  limiteIngresoMXN?: number;
  /** True si los ingresos (cuando se pasan) exceden el límite. */
  excedeLimite?: boolean;
  fundamento: { ley: string; articulo: string };
  verificado: boolean;
}

/**
 * Aplica la reducción del ISR de AGAPES (Art. 74) sobre el impuesto determinado.
 * Si se pasa `ingresoAnual`, marca `excedeLimite` cuando rebasa 423 UMA anuales
 * (el llamador decide cómo tratar el excedente). Devuelve null si no es AGAPES.
 */
export function reduccionIsrAgapes(
  ctx: Contexto,
  isrDeterminado: number,
  opts?: { ingresoAnual?: number },
): ReduccionIsrAgapes | null {
  const pct = getRule<number>("agapes.reduccion_isr.pct", ctx);
  if (!pct) return null;

  const reduccionMXN = r2(isrDeterminado * pct.valor);

  const limite = getRule<number>("agapes.reduccion_isr.limite_uma_anual", ctx);
  const uma = getRule<Tabla>("uma.valor", ctx);
  let limiteIngresoMXN: number | undefined;
  let excedeLimite: boolean | undefined;
  if (limite && uma) {
    limiteIngresoMXN = r2(limite.valor * uma.valor.anual);
    if (opts?.ingresoAnual !== undefined) excedeLimite = opts.ingresoAnual > limiteIngresoMXN;
  }

  return {
    isrReducido: r2(isrDeterminado - reduccionMXN),
    reduccionMXN,
    reduccionPct: pct.valor,
    limiteIngresoMXN,
    excedeLimite,
    fundamento: pct.fundamento,
    verificado: pct.verificado,
  };
}

export interface FacilidadAgapes {
  /** Monto deducible sin CFDI, MXN (min(% × ingreso, tope)). */
  facilidadMXN: number;
  /** Fracción aplicada (0.10). */
  pct: number;
  /** Tope anual, MXN. */
  tope?: number;
  /** True si el % del ingreso quedó topado. */
  topado: boolean;
  /** Tope por gasto menor individual, MXN. */
  gastoMenorTope?: number;
  fundamento: { ley: string; articulo: string };
  verificado: boolean;
}

/**
 * Deducción sin CFDI de la RFA (mano de obra eventual del campo, alimentación de
 * ganado, gastos menores): min(pct × ingresoPropio, tope). Devuelve null si no
 * es AGAPES o no hay RFA vigente para la fecha.
 */
export function facilidadDeduccionAgapes(
  ctx: Contexto,
  ingresoPropio: number,
): FacilidadAgapes | null {
  const pct = getRule<number>("agapes.rfa.facilidad_pct", ctx);
  if (!pct) return null;

  const tope = getRule<number>("agapes.rfa.facilidad_tope", ctx);
  const gastoMenor = getRule<number>("agapes.rfa.gasto_menor_tope", ctx);

  const porPct = r2(ingresoPropio * pct.valor);
  const topeMXN = tope?.valor;
  const facilidadMXN = topeMXN !== undefined ? Math.min(porPct, topeMXN) : porPct;

  return {
    facilidadMXN,
    pct: pct.valor,
    tope: topeMXN,
    topado: topeMXN !== undefined && porPct > topeMXN,
    gastoMenorTope: gastoMenor?.valor,
    fundamento: pct.fundamento,
    verificado: pct.verificado && (tope?.verificado ?? true),
  };
}
