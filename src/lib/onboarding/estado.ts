// ─────────────────────────────────────────────────────────────────────────────
// Estado de la CARGA INICIAL de una empresa y qué falta empujar.
//
// El pipeline de una empresa nueva es una cadena: el SAT entrega XMLs →  de
// esos XMLs se derivan impuestos, contraparte y vigencia. Cada eslabón vive en
// su propio cron gap-driven, y cada cron corre cada 6 horas compartiendo su
// presupuesto con TODO el portafolio. El resultado es que una empresa recién
// onboardeada tarda días o semanas en quedar al corriente — y en la práctica
// alguien terminaba empujando los crons a mano con curl para cada cliente nuevo.
//
// Este módulo es el cerebro del orquestador: dice, para cada empresa, qué
// eslabones le faltan y qué cron los avanza. La decisión es PURA (recibe los
// conteos ya medidos); la consulta vive en el route.
//
// Diseño para escala: los conteos se sacan con UNA consulta agregada sobre
// todo el portafolio, no con N consultas por empresa.
// ─────────────────────────────────────────────────────────────────────────────

/** Conteos por empresa que alimentan la evaluación (una fila por empresa). */
export interface ConteosEmpresa {
  companyId: string;
  /** CFDIs importados. */
  total: number;
  /** Con el XML original guardado — sin él no se deriva nada. */
  conXml: number;
  /** Con desglose de impuestos parseado. */
  conImpuestos: number;
  /** Con nombre/RFC de contraparte resuelto. */
  conContraparte: number;
  /** Con vigencia verificada por UUID (cancelaciones). */
  conVigencia: number;
  /** ¿El backfill de CFDIs del SAT ya terminó? (Company.satBackfillCompletedAt) */
  backfillCompleto: boolean;
}

export interface EtapaCarga {
  clave: string;
  etiqueta: string;
  hechos: number;
  total: number;
  /** 0-100; null cuando todavía no hay universo que medir. */
  pct: number | null;
  completa: boolean;
  /** Cron que la avanza; null cuando no hay uno que empujar por empresa. */
  cron: string | null;
}

/**
 * Umbral de tolerancia: una etapa se considera completa al llegar aquí. No se
 * exige el 100% porque siempre queda un residuo legítimo — CFDIs cuyo XML no
 * trae el dato, comprobantes sin impuestos, filas que el SAT no reconoce. Sin
 * tolerancia, una empresa quedaría "cargando" para siempre por tres filas.
 */
export const UMBRAL_COMPLETA = 0.98;

/** Etapas derivadas del archivo, en el orden en que se alimentan. */
export function evaluarEtapas(c: ConteosEmpresa): EtapaCarga[] {
  const etapa = (
    clave: string,
    etiqueta: string,
    hechos: number,
    cron: string | null,
  ): EtapaCarga => {
    const pct = c.total > 0 ? Math.round((hechos / c.total) * 100) : null;
    return {
      clave,
      etiqueta,
      hechos,
      total: c.total,
      pct,
      // Sin CFDIs todavía no hay nada que derivar: la etapa no está "completa",
      // simplemente aún no aplica — y se marca completa para no empujar en vano.
      completa: c.total === 0 ? true : hechos / c.total >= UMBRAL_COMPLETA,
      cron,
    };
  };

  return [
    {
      clave: "cfdis",
      etiqueta: "Descarga de CFDIs del SAT",
      hechos: c.total,
      total: c.total,
      pct: c.backfillCompleto ? 100 : null,
      completa: c.backfillCompleto,
      // sat-backfill ya prioriza empresas nuevas por su cuenta (nulls-first).
      cron: null,
    },
    etapa("xml", "XML original guardado", c.conXml, "sat-rawxml-backfill"),
    etapa("impuestos", "Desglose de impuestos", c.conImpuestos, "invoice-taxes-backfill"),
    etapa("contraparte", "Nombre de la contraparte", c.conContraparte, "invoice-contraparte-backfill"),
    etapa("vigencia", "Verificación de cancelaciones", c.conVigencia, "sat-vigencia-sync"),
  ];
}

/** ¿La empresa terminó su carga inicial? */
export function cargaCompleta(etapas: EtapaCarga[]): boolean {
  return etapas.every((e) => e.completa);
}

/**
 * Crons a empujar para esta empresa, en el orden de la cadena: no tiene caso
 * derivar impuestos de un XML que aún no se ha bajado. Devuelve sólo los de la
 * PRIMERA etapa incompleta que tenga cron — empujar los de más adelante sería
 * trabajo en vano hasta que el eslabón previo avance.
 */
export function cronsPendientes(etapas: EtapaCarga[]): string[] {
  for (const e of etapas) {
    if (e.completa) continue;
    return e.cron ? [e.cron] : [];
  }
  return [];
}

/**
 * Empresas que necesitan empuje, más atrasada primero. El orden por avance
 * (y no por antigüedad) hace que el orquestador dedique sus corridas a quien
 * está peor, que es justo la empresa recién onboardeada.
 */
export function empresasPorAtender(
  conteos: ConteosEmpresa[],
  maxEmpresas: number,
): Array<{ companyId: string; etapas: EtapaCarga[]; crons: string[] }> {
  return conteos
    .map((c) => {
      const etapas = evaluarEtapas(c);
      return { companyId: c.companyId, etapas, crons: cronsPendientes(etapas) };
    })
    .filter((e) => e.crons.length > 0)
    .sort((a, b) => avanceGlobal(a.etapas) - avanceGlobal(b.etapas))
    .slice(0, maxEmpresas);
}

/** Promedio de avance de las etapas medibles (0-1); 1 cuando no hay nada que medir. */
export function avanceGlobal(etapas: EtapaCarga[]): number {
  const medibles = etapas.filter((e) => e.pct != null);
  if (medibles.length === 0) return 1;
  return medibles.reduce((s, e) => s + (e.pct as number) / 100, 0) / medibles.length;
}
