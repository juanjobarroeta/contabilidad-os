// ─────────────────────────────────────────────────────────────────────────────
// Diversificación por documento del top-k.
//
// Hallazgo del eval (Fase 0): en 9 de 35 fallos de recuperación, CINCO de los
// seis lugares del top-6 los ocupaban chunks de la MISMA guía de llenado, y el
// artículo del CFF que sí respondía quedaba fuera. Una guía larga y prolija
// produce muchos chunks parecidos entre sí; el vecino más cercano no es el
// mejor conjunto de evidencia.
//
// Regla: a lo más `maxPorDoc` chunks por documento entre los `limit`
// entregados, respetando el orden de similitud. Puro y testeable.
// ─────────────────────────────────────────────────────────────────────────────

export function diversificarPorDocumento<T extends { documentId: string }>(
  ordenados: T[],
  limit: number,
  maxPorDoc = 2
): T[] {
  const porDoc = new Map<string, number>();
  const out: T[] = [];
  for (const r of ordenados) {
    if (out.length >= limit) break;
    const n = porDoc.get(r.documentId) ?? 0;
    if (n >= maxPorDoc) continue;
    porDoc.set(r.documentId, n + 1);
    out.push(r);
  }
  return out;
}
