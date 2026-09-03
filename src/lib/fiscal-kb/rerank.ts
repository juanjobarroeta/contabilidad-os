// ─────────────────────────────────────────────────────────────────────────────
// Rerank de candidatos con un modelo barato (Fase 2 del copiloto).
//
// El embedding no distingue «Art. 106 LISR» de «Art. 107 LISR» ni sabe que
// para una pregunta de deducciones la LEY va antes que su REGLAMENTO. Un
// modelo que LEE la pregunta y los ~20 candidatos sí. Un solo llamado, JSON de
// salida, y si algo falla se devuelve null y la búsqueda sigue con el orden
// fusionado — el rerank nunca rompe una consulta. Costo medido en CostEvent
// con subtipo "ai.rerank".
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import { meteredCreate } from "@/lib/costos/anthropic";
import type { CostCtx } from "@/lib/costos/record";

export const RERANK_MODEL = process.env.AI_RERANK_MODEL ?? "claude-haiku-4-5-20251001";
/** Caracteres de cada candidato que ve el modelo (el encabezado del artículo va al principio). */
const EXTRACTO_CHARS = 600;

export interface CandidatoRerank {
  id: string;
  cita: string;
  texto: string;
}

const SYSTEM = `Eres un fiscalista mexicano experto. Recibes una pregunta y una lista numerada de fragmentos de leyes, reglamentos, reglas de la RMF o guías del SAT. Ordena los fragmentos de MÁS a MENOS útiles para fundamentar la respuesta a esa pregunta exacta.
Criterios: (1) el fragmento responde directamente lo que se pregunta; (2) la LEY va antes que su reglamento cuando ambos tratan lo mismo; (3) el artículo exacto va antes que uno vecino que sólo comparte tema; (4) una guía de llenado sólo va arriba si la pregunta es de cómo llenar un CFDI.
Responde ÚNICAMENTE con JSON: {"orden": [números de los fragmentos, mejor primero]}. Incluye todos los números; no expliques.`;

/** Aplica el orden que devolvió el modelo; lo que no mencione va al final en el orden original. */
export function aplicarOrden<T extends { id: string }>(orden: unknown, candidatos: T[]): T[] | null {
  if (!Array.isArray(orden)) return null;
  const porId = new Map(candidatos.map((c) => [c.id, c]));
  const out: T[] = [];
  const vistos = new Set<string>();
  for (const x of orden) {
    const id = typeof x === "number" ? candidatos[x - 1]?.id : typeof x === "string" ? x : undefined;
    if (!id || vistos.has(id) || !porId.has(id)) continue;
    vistos.add(id);
    out.push(porId.get(id)!);
  }
  if (out.length === 0) return null;
  for (const c of candidatos) if (!vistos.has(c.id)) out.push(c);
  return out;
}

function extraerJson(texto: string): unknown {
  const m = texto.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

export async function rerankCandidatos<T extends CandidatoRerank>(
  pregunta: string,
  candidatos: T[],
  opts: { cost?: CostCtx; client?: Anthropic } = {}
): Promise<T[] | null> {
  const client = opts.client ?? new Anthropic();
  if (candidatos.length < 2) return candidatos;
  const lista = candidatos
    .map((c, i) => `[${i + 1}] ${c.cita}\n${c.texto.replace(/\s+/g, " ").slice(0, EXTRACTO_CHARS)}`)
    .join("\n\n");
  try {
    const msg = await meteredCreate(
      client,
      { companyId: null, ...opts.cost, subtipo: "ai.rerank" },
      {
        model: RERANK_MODEL,
        max_tokens: 200,
        system: SYSTEM,
        messages: [{ role: "user", content: `Pregunta: ${pregunta}\n\nFragmentos:\n\n${lista}` }],
      }
    );
    const texto = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const json = extraerJson(texto) as { orden?: unknown } | null;
    return aplicarOrden(json?.orden, candidatos);
  } catch (err) {
    console.error("[rerank] falló, se usa el orden fusionado:", err instanceof Error ? err.message : err);
    return null;
  }
}
