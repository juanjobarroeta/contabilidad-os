// ─────────────────────────────────────────────────────────────────────────────
// Pase de verificación de citas (Fase 3 del copiloto).
//
// El juez del eval dijo lo que un contador senior diría: el copiloto casi
// nunca cita un artículo falso, pero a veces le ATRIBUYE algo que no dice
// (una fracción equivocada, una «reforma DOF 07-11-2025» inventada, montos
// «vigentes 2026» sin fuente). Este pase corre DESPUÉS de la respuesta:
//
//   1. Extrae las citas del texto (extraerCitas, la misma regex del eval).
//   2. Las que la KB no devolvió en el turno se traen con getArticulo — si
//      existen, se verifican; si no existen en la KB, se marcan «no
//      verificada» (nunca se tachan a ciegas: el modelo puede saber más que
//      la KB, pero el usuario merece saber qué no pudimos comprobar).
//   3. Un modelo barato lee la respuesta con el texto real de cada artículo
//      citado y devuelve las afirmaciones que NO se sostienen, más una
//      versión corregida mínima (misma respuesta, sin lo insostenible).
//
// Nunca rompe un turno: cualquier fallo devuelve la respuesta original con
// `verificada: false`. Costo: un llamado a Haiku, subtipo "ai.verificacion".
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import { meteredCreate } from "@/lib/costos/anthropic";
import type { CostCtx } from "@/lib/costos/record";
import { getArticulo } from "@/lib/fiscal-kb/search";
import { claveCita, extraerCitas } from "@/lib/ai/eval/medidas";

export const VERIFICACION_MODEL = process.env.AI_VERIFICACION_MODEL ?? "claude-haiku-4-5-20251001";
/** Caracteres por fuente y en total que ve el verificador. */
const FUENTE_MAX = 3500;
const FUENTES_TOTAL_MAX = 28000;

export interface FuenteVerificacion {
  cita: string;
  texto: string;
}

export interface ProblemaVerificacion {
  afirmacion: string;
  cita: string;
  motivo: string;
}

export interface ResultadoVerificacion {
  /** La respuesta que se entrega: la original o la corregida. */
  texto: string;
  /** false = no aplicó (sin citas) o falló el pase; el texto es el original. */
  verificada: boolean;
  corregida: boolean;
  problemas: ProblemaVerificacion[];
  /** Citas que ni la KB devolvió ni existen en ella (se marcan en el texto). */
  citasNoVerificables: string[];
  ms: number;
}

/** Separa las citas del texto en sostenidas (la KB las devolvió) y faltantes. Puro. */
export function clasificarCitas(citasEnTexto: string[], citasKB: string[]): { sostenidas: string[]; faltantes: string[] } {
  const kb = new Set(citasKB.map(claveCita));
  const sostenidas: string[] = [];
  const faltantes: string[] = [];
  for (const c of citasEnTexto) (kb.has(claveCita(c)) ? sostenidas : faltantes).push(c);
  return { sostenidas, faltantes };
}

/** «ART. 27 LISR» → { clave: "LISR", articulo: "27" }; «REGLA 2.7.1.32 RMF» → { clave: "RMF", articulo: "2.7.1.32" }. Puro. */
export function parsearCita(cita: string): { clave: string; articulo: string } | null {
  const m = cita.trim().match(/^(?:ART\.?|ARTÍCULO)\s+([0-9][0-9A-Za-z-]*(?:\s+BIS)?)\s+([A-Z]+)$/i);
  if (m) {
    return { clave: m[2].toUpperCase(), articulo: m[1].replace(/\s+bis$/i, " Bis").replace(/^(\d+-)([a-z]+)/i, (_, d, l) => d + l.toUpperCase()) };
  }
  const r = cita.trim().match(/^REGLA\s+(\d+(?:\.\d+){2,3})\s+RMF(?:-\d{4})?$/i);
  if (r) return { clave: "RMF", articulo: r[1] };
  return null;
}

export interface VeredictoVerificacion {
  ok: boolean;
  problemas: ProblemaVerificacion[];
  respuestaCorregida: string | null;
}

/** Parsea el JSON del verificador; null si no es usable. Puro. */
export function parsearVeredicto(texto: string): VeredictoVerificacion | null {
  const m = texto.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j: unknown;
  try {
    j = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  const problemas = Array.isArray(o.problemas)
    ? o.problemas
        .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
        .map((p) => ({
          afirmacion: String(p.afirmacion ?? "").trim(),
          cita: String(p.cita ?? "").trim(),
          motivo: String(p.motivo ?? "").trim(),
        }))
        .filter((p) => p.afirmacion.length > 0)
    : [];
  const ok = o.ok === true || problemas.length === 0;
  const respuestaCorregida = typeof o.respuestaCorregida === "string" && o.respuestaCorregida.trim().length > 20 ? o.respuestaCorregida.trim() : null;
  return { ok, problemas, respuestaCorregida };
}

const SYSTEM = `Eres un contador fiscalista senior mexicano que REVISA la respuesta de un asistente antes de que llegue al cliente. Recibes la pregunta, la respuesta, y el TEXTO REAL de cada artículo/regla que la respuesta cita. Tu trabajo es detectar afirmaciones que los textos NO sostienen: una fracción atribuida al artículo equivocado, un plazo, monto, tasa, fecha de reforma o vigencia que el texto no dice, un requisito que no está.
Reglas:
- Sólo son problema las afirmaciones ATRIBUIDAS a una cita cuyo texto tienes y no las sostiene. Lo que no se atribuye a ninguna cita, o se atribuye a una cita marcada como NO VERIFICABLE, no lo juzgues: sólo asegúrate de que en la versión corregida quede señalado como «no verificado en la base».
- No opines sobre estilo ni completes la respuesta. No agregues fundamentos nuevos.
- Si todo se sostiene: {"ok": true, "problemas": [], "respuestaCorregida": null}.
- Si hay problemas: {"ok": false, "problemas": [{"afirmacion": "...", "cita": "Art. X LEY", "motivo": "una línea"}], "respuestaCorregida": "la MISMA respuesta, con cada afirmación insostenible retirada o reescrita como «no pude verificarlo en el texto del Art. X»; todo lo demás idéntico, mismo formato"}.
Responde ÚNICAMENTE el JSON.`;

export async function verificarRespuesta(
  client: Anthropic,
  input: { pregunta: string; respuesta: string; fuentes: FuenteVerificacion[]; cost?: CostCtx; fechaVigencia?: Date }
): Promise<ResultadoVerificacion> {
  const t0 = Date.now();
  const original: ResultadoVerificacion = { texto: input.respuesta, verificada: false, corregida: false, problemas: [], citasNoVerificables: [], ms: 0 };
  const citas = extraerCitas(input.respuesta);
  if (citas.length === 0) return original;

  try {
    const { faltantes } = clasificarCitas(citas, input.fuentes.map((f) => f.cita));
    const fuentes = new Map<string, FuenteVerificacion>();
    for (const f of input.fuentes) {
      const k = claveCita(f.cita);
      const prev = fuentes.get(k);
      fuentes.set(k, prev ? { cita: prev.cita, texto: `${prev.texto}\n${f.texto}` } : f);
    }
    const noVerificables: string[] = [];
    for (const c of faltantes) {
      const ref = parsearCita(c);
      const art = ref ? await getArticulo(ref.clave, ref.articulo, input.fechaVigencia) : null;
      if (art) fuentes.set(claveCita(c), { cita: art.cita, texto: art.partes.map((p) => p.texto).join("\n") });
      else noVerificables.push(c);
    }

    let total = 0;
    const bloques: string[] = [];
    for (const f of fuentes.values()) {
      const t = f.texto.length > FUENTE_MAX ? `${f.texto.slice(0, FUENTE_MAX)}\n[… recortado]` : f.texto;
      if (total + t.length > FUENTES_TOTAL_MAX) break;
      total += t.length;
      bloques.push(`### ${f.cita}\n${t}`);
    }

    const user = `Pregunta del cliente:\n${input.pregunta}\n\nRespuesta a revisar:\n"""\n${input.respuesta}\n"""\n\nCitas NO VERIFICABLES (no existen en la base; sólo márcalas): ${noVerificables.length ? noVerificables.join(" | ") : "(ninguna)"}\n\nTextos reales de las citas:\n\n${bloques.join("\n\n") || "(ninguno)"}`;

    const msg = await meteredCreate(
      client,
      { companyId: null, ...input.cost, subtipo: "ai.verificacion" },
      { model: VERIFICACION_MODEL, max_tokens: 4000, system: SYSTEM, messages: [{ role: "user", content: user }] }
    );
    const texto = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const v = parsearVeredicto(texto);
    if (!v) return { ...original, ms: Date.now() - t0 };

    const usarCorregida = !v.ok && v.respuestaCorregida !== null;
    return {
      texto: usarCorregida ? v.respuestaCorregida! : input.respuesta,
      verificada: true,
      corregida: usarCorregida,
      problemas: v.problemas,
      citasNoVerificables: noVerificables,
      ms: Date.now() - t0,
    };
  } catch (err) {
    console.error("[ai.verificacion] falló, se entrega la respuesta original:", err instanceof Error ? err.message : err);
    return { ...original, ms: Date.now() - t0 };
  }
}

/** Fuentes de un turno a partir de los JSON que devolvieron las tools de la KB. */
export function fuentesDesdeToolResult(toolName: string, out: string): FuenteVerificacion[] {
  try {
    const parsed = JSON.parse(out) as { resultados?: { cita: string; texto: string }[]; cita?: string; partes?: { texto: string }[] };
    if (toolName === "search_fiscal_knowledge") return (parsed.resultados ?? []).map((h) => ({ cita: h.cita, texto: h.texto }));
    if (toolName === "get_articulo" && typeof parsed.cita === "string") return [{ cita: parsed.cita, texto: (parsed.partes ?? []).map((p) => p.texto).join("\n") }];
  } catch {
    /* sin fuentes en este resultado */
  }
  return [];
}
