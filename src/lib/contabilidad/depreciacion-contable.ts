// ─────────────────────────────────────────────────────────────────────────────
// Depreciación CONTABLE mensual (al libro) — Fase 3 del roadmap.
//
// La depreciación fiscal (Arts. 31/34/36 LISR, con tope de automóvil y
// actualización INPC) vive en src/lib/fiscal/depreciacion.ts y alimenta la
// declaración. El LIBRO lleva la depreciación CONTABLE: nominal (sin INPC —
// la actualización es extracontable) y SIN tope de automóvil (el tope Art.
// 36-II es fiscal). Deliberadamente reutiliza el mismo motor de meses-de-uso
// para que contable y fiscal difieran sólo por tope/INPC — esa delta se
// muestra en el activo fijo como conciliación contable-fiscal.
//
// Módulo PURO (sin Prisma): postMonth lo cablea con los ActivoFijo del mes.
// Los asientos generados llevan fuente DEPRECIACION (regenerable: postMonth
// los borra y reconstruye idempotentemente igual que CFDI/NOMINA/BANCO).
// ─────────────────────────────────────────────────────────────────────────────

import {
  calcularDepreciacionEjercicio,
  tipoActivoDesdeSubtipo,
  type TipoActivo,
} from "../fiscal/depreciacion";

/** Cuenta de ACTIVO FIJO (15x/16x oficiales) por tipo. */
export const CUENTA_ACTIVO_FIJO: Record<TipoActivo, string> = {
  construccion:   "152.01", // Edificios
  maquinaria:     "153.01", // Maquinaria y equipo
  transporte:     "154.01", // Automóviles, autobuses, camiones…
  mobiliario:     "155.01", // Mobiliario y equipo de oficina
  computo:        "156.01", // Equipo de cómputo
  comunicaciones: "157.01", // Equipo de comunicación
  herramental:    "164.01", // Troqueles, moldes, matrices y herramental
  otro:           "160.01", // Otros activos fijos
};

/** Depreciación acumulada (171.xx oficiales) por tipo. La lista del SAT no
 *  trae renglón para automóviles (no existe 171.03) — transporte cae en
 *  171.08 «otros activos fijos», práctica común. */
export const CUENTA_DEPRECIACION_ACUMULADA: Record<TipoActivo, string> = {
  construccion:   "171.01",
  maquinaria:     "171.02",
  transporte:     "171.08",
  mobiliario:     "171.04",
  computo:        "171.05",
  comunicaciones: "171.06",
  herramental:    "171.12",
  otro:           "171.08",
};

/** Pérdida en baja (703.xx oficiales) por tipo; el SAT tampoco lista
 *  automóviles aquí — cae en 703.09. */
export const CUENTA_PERDIDA_BAJA: Record<TipoActivo, string> = {
  construccion:   "703.02",
  maquinaria:     "703.03",
  transporte:     "703.09",
  mobiliario:     "703.05",
  computo:        "703.06",
  comunicaciones: "703.07",
  herramental:    "703.09",
  otro:           "703.09",
};

/** Gasto por depreciación: el código agrupador NO tiene renglón propio para el
 *  gasto contable por depreciación — se registra en 601.84 «Otros gastos
 *  generales» con concepto distintivo (elección documentada). */
export const CUENTA_GASTO_DEPRECIACION = "601.84";

export interface ActivoParaDepreciar {
  id: string;
  descripcion: string;
  /** Subtipo libre de la ficha; se normaliza con tipoActivoDesdeSubtipo. */
  tipo: string | null;
  moi: number;
  fechaInicioUso: Date;
  tasaAnual: number | null;
  fechaBaja: Date | null;
}

export interface DepreciacionMensual {
  activoId: string;
  descripcion: string;
  tipo: TipoActivo;
  /** Depreciación contable del MES (nominal, sin tope de auto). */
  monto: number;
  cuentaGasto: string;
  cuentaAcumulada: string;
}

export interface BajaActivo {
  activoId: string;
  descripcion: string;
  tipo: TipoActivo;
  moi: number;
  /** Acumulada contable a la fecha de baja (incluye la del mes de baja). */
  acumuladaALaBaja: number;
  /** Valor en libros que se manda a resultados (703.xx). */
  valorEnLibros: number;
  cuentaActivo: string;
  cuentaAcumulada: string;
  cuentaPerdida: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Depreciación contable nominal acumulada de un activo hasta el CIERRE del
 *  ejercicio `hastaEjercicio` (inclusive), o hasta `hastaMes` de ese año. */
export function acumuladaContableHasta(
  a: ActivoParaDepreciar,
  hastaEjercicio: number,
  hastaMes?: number
): number {
  const inicio = a.fechaInicioUso.getUTCFullYear();
  let acumulada = 0;
  for (let e = inicio; e <= hastaEjercicio; e++) {
    const res = calcularDepreciacionEjercicio({
      moi: a.moi,
      fechaAdquisicion: a.fechaInicioUso,
      tipo: tipoActivoDesdeSubtipo(a.tipo),
      ejercicio: e,
      esAutomovil: false, // contable: sin tope Art. 36-II
      fechaBaja: a.fechaBaja,
      depreciacionAcumuladaPrevia: acumulada,
      ...(a.tasaAnual != null && a.tasaAnual > 0 ? { tasaOverride: a.tasaAnual } : {}),
      ...(e === hastaEjercicio && hastaMes != null ? { hastaMes } : {}),
    });
    acumulada = r2(acumulada + res.depreciacionNominalEjercicio);
  }
  return acumulada;
}

/** Depreciación contable del mes = acumulada(hasta mes) − acumulada(hasta mes−1). */
export function depreciacionDelMes(a: ActivoParaDepreciar, year: number, month: number): number {
  const hastaEste = acumuladaContableHasta(a, year, month);
  const hastaPrevio =
    month === 1 ? acumuladaContableHasta(a, year - 1) : acumuladaContableHasta(a, year, month - 1);
  return r2(Math.max(0, hastaEste - hastaPrevio));
}

/**
 * Calcula la depreciación contable del mes para un conjunto de activos, más
 * las bajas del mes (cancelación de MOI y acumulada; valor en libros → 703.xx).
 */
export function calcularDepreciacionMes(
  activos: ActivoParaDepreciar[],
  year: number,
  month: number
): { mensuales: DepreciacionMensual[]; bajas: BajaActivo[] } {
  const inicioMes = Date.UTC(year, month - 1, 1);
  const finMes = Date.UTC(year, month, 1);

  const mensuales: DepreciacionMensual[] = [];
  const bajas: BajaActivo[] = [];

  for (const a of activos) {
    if (!(a.moi > 0)) continue;
    if (a.fechaInicioUso.getTime() >= finMes) continue; // aún no entra en uso

    const tipo = tipoActivoDesdeSubtipo(a.tipo);
    const monto = depreciacionDelMes(a, year, month);
    if (monto > 0.005) {
      mensuales.push({
        activoId: a.id,
        descripcion: a.descripcion,
        tipo,
        monto,
        cuentaGasto: CUENTA_GASTO_DEPRECIACION,
        cuentaAcumulada: CUENTA_DEPRECIACION_ACUMULADA[tipo],
      });
    }

    // Baja en este mes: cancelar MOI y acumulada; el remanente va a resultados.
    const baja = a.fechaBaja ? a.fechaBaja.getTime() : null;
    if (baja != null && baja >= inicioMes && baja < finMes) {
      const acumuladaALaBaja = acumuladaContableHasta(a, year, month);
      const valorEnLibros = r2(Math.max(0, a.moi - acumuladaALaBaja));
      bajas.push({
        activoId: a.id,
        descripcion: a.descripcion,
        tipo,
        moi: r2(a.moi),
        acumuladaALaBaja,
        valorEnLibros,
        cuentaActivo: CUENTA_ACTIVO_FIJO[tipo],
        cuentaAcumulada: CUENTA_DEPRECIACION_ACUMULADA[tipo],
        cuentaPerdida: CUENTA_PERDIDA_BAJA[tipo],
      });
    }
  }

  return { mensuales, bajas };
}
