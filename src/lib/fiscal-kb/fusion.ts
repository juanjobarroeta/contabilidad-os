// ─────────────────────────────────────────────────────────────────────────────
// Fusión de brazos de búsqueda (vector + léxico + exacto) — puro y testeable.
//
// Fase 2 del plan del copiloto («recuperar como fiscalista»). El eval dijo que
// el vector solo no distingue el artículo exacto (106 vs 107, 96 vs 97) y que
// el Art. 29-A CFF no aparece ni entre 40 candidatos cuando las guías de
// llenado comparten vocabulario con la pregunta. Dos brazos más:
//   - léxico (tsvector en Postgres): gana por las palabras exactas;
//   - exacto: si la pregunta ya nombra «artículo 27» o «regla 2.7.1.32», ese
//     chunk entra primero, sin pedirle permiso al embedding.
// Se fusionan con RRF (Reciprocal Rank Fusion): score = Σ 1/(k + rango) por
// brazo; k = 60 es el valor clásico y no hay nada que afinar a ojo.
// ─────────────────────────────────────────────────────────────────────────────

export const RRF_K = 60;

/**
 * Fusiona listas ordenadas (mejor primero) por RRF. `clave` identifica el
 * mismo elemento entre brazos. Devuelve los elementos únicos, mejor primero,
 * conservando el objeto de la primera lista en que aparecieron.
 */
export function fusionarRRF<T>(brazos: T[][], clave: (t: T) => string, k = RRF_K): { item: T; score: number; brazos: number }[] {
  const acc = new Map<string, { item: T; score: number; brazos: number }>();
  for (const lista of brazos) {
    lista.forEach((item, i) => {
      const c = clave(item);
      const prev = acc.get(c);
      const aporte = 1 / (k + i + 1);
      if (prev) {
        prev.score += aporte;
        prev.brazos += 1;
      } else {
        acc.set(c, { item, score: aporte, brazos: 1 });
      }
    });
  }
  return [...acc.values()].sort((a, b) => b.score - a.score);
}

// ── Referencias exactas en la pregunta ───────────────────────────────────────

export interface ReferenciaExacta {
  /** Número tal como se guarda en FiscalChunk.articulo ("27", "29-A", "113-E", "2.7.1.32"). */
  articulo: string;
  /** Clave del documento si la pregunta la nombra (LISR, CFF, RMF…); null = cualquiera. */
  clave: string | null;
}

const CLAVES = "RLISR|RLIVA|RCFF|CCOM|LGSM|RLFPIORPI|LFPIORPI|LFDC|RACERF|RIPAEDI|LHPUE|CFPUE|CFCDMX|LISR|LIVA|CFF|LIEPS|LSS|LINFONAVIT|LFT|RMF";
// «artículo 27», «art. 29-A del CFF», «artículo 113-E de la LISR», «Art 17-H Bis»
const RE_ART_PREGUNTA = new RegExp(
  `\\bart(?:[íi]culo|\\.)?\\s*(\\d+(?:-[A-Za-z]+)?(?:\\s+bis)?)(?:\\s*,?\\s*fracci[óo]n\\s+[IVXL]+)?(?:\\s*(?:de\\s+la\\s+|del\\s+)?(?:ley\\s+del\\s+)?(${CLAVES}))?\\b`,
  "gi"
);
// «regla 2.7.1.32», «regla 3.10.4 de la RMF»
const RE_REGLA_PREGUNTA = /\bregla\s+(\d+(?:\.\d+){2,3})\b/gi;

/** Normaliza al formato de FiscalChunk.articulo: «29-a» → «29-A», «17-h bis» → «17-H Bis». */
function normalizarNumero(n: string): string {
  return n
    .replace(/\s+/g, " ")
    .replace(/^(\d+)-([a-z]+)/i, (_, d, l) => `${d}-${l.toUpperCase()}`)
    .replace(/\bbis$/i, "Bis");
}

/** Artículos / reglas que la pregunta nombra explícitamente. */
export function referenciasExactas(pregunta: string): ReferenciaExacta[] {
  const out: ReferenciaExacta[] = [];
  const vistos = new Set<string>();
  const push = (r: ReferenciaExacta) => {
    const k = `${r.clave ?? "*"}#${r.articulo}`;
    if (!vistos.has(k)) {
      vistos.add(k);
      out.push(r);
    }
  };
  for (const m of pregunta.matchAll(RE_ART_PREGUNTA)) {
    push({ articulo: normalizarNumero(m[1]), clave: m[2] ? m[2].toUpperCase() : null });
  }
  for (const m of pregunta.matchAll(RE_REGLA_PREGUNTA)) push({ articulo: m[1], clave: "RMF" });
  return out;
}
