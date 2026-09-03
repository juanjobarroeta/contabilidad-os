// ─────────────────────────────────────────────────────────────────────────────
// Diversificación del top-k por UNIDAD legal.
//
// Hallazgo del eval (Fase 0): en 9 de 35 fallos de recuperación, CINCO de los
// seis lugares del top-6 los ocupaban chunks de la MISMA guía de llenado, y el
// artículo del CFF que sí respondía quedaba fuera. Una guía larga y prolija
// produce muchos chunks parecidos entre sí; el vecino más cercano no es el
// mejor conjunto de evidencia.
//
// Lección de la Fase 1a (58 % → 33 %): capar por DOCUMENTO fue un error. Una
// ley es un solo documento con cientos de artículos distintos, y una pregunta
// de ISR necesita varios artículos de la LISR en el top-6 — con dos lugares
// por ley, los demás los llenaban el reglamento y las leyes de nómina, y el
// artículo correcto (que sí estaba en los candidatos) se quedaba fuera. Peor:
// con 40 candidatos repartidos en 3–4 leyes, el tope los agotaba y la
// búsqueda devolvía 4 resultados en vez de 6.
//
// Regla vigente: a lo más `maxPorUnidad` chunks por unidad legal, donde la
// unidad es el artículo/regla (documento + articulo). Dos artículos de la
// misma ley nunca compiten entre sí; las partes de un artículo largo sí.
// Una guía no tiene artículos (articulo = null) → su unidad es el documento
// entero, que es exactamente el tope que la Fase 0 quería. Puro y testeable.
// ─────────────────────────────────────────────────────────────────────────────

export interface ChunkDiversificable {
  documentId: string;
  articulo: string | null;
}

export function claveUnidad(c: ChunkDiversificable): string {
  return `${c.documentId}#${c.articulo ?? ""}`;
}

export function diversificarPorUnidad<T extends ChunkDiversificable>(
  ordenados: T[],
  limit: number,
  maxPorUnidad = 2
): T[] {
  const porUnidad = new Map<string, number>();
  const out: T[] = [];
  for (const r of ordenados) {
    if (out.length >= limit) break;
    const k = claveUnidad(r);
    const n = porUnidad.get(k) ?? 0;
    if (n >= maxPorUnidad) continue;
    porUnidad.set(k, n + 1);
    out.push(r);
  }
  return out;
}
