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
// Lección del run 25 del eval (primera medición, 69 de 73 respuestas
// «corregidas», citas fuera de la KB 15 % → 26 %): el verificador veía el
// CHUNK que devolvió la búsqueda (una parte de ~2 500 chars) o los primeros
// 3 500 chars del artículo, y concluía «el Art. 27 no contiene la fracción V»
// — 76 de 140 problemas eran ausencias en un texto recortado, no
// contradicciones. Y la versión corregida agregaba citas de memoria. Por eso:
//   - toda cita se coteja contra la UNIDAD COMPLETA (getArticulo, todas las
//     partes), y si no cabe, se conservan las partes de las fracciones que la
//     respuesta menciona y se le dice al modelo que el texto está recortado;
//   - sólo cuenta como problema lo que el texto CONTRADICE (o una fracción /
//     monto / fecha que no está en un texto marcado como completo);
//   - una corrección que introduce citas nuevas o encoge la respuesta se
//     descarta (se entrega la original).
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
/** Caracteres por fuente y en total que ve el verificador (Haiku: ~15 k tokens). */
const FUENTE_MAX = 12000;
const FUENTES_TOTAL_MAX = 60000;
/** Una corrección que encoge la respuesta por debajo de esto se descarta. */
const CORRECCION_MIN_RATIO = 0.4;

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
  /** Motivo por el que se descartó la versión corregida del modelo (si aplica). */
  descartada?: string;
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

const ROMANO = "[IVXLC]+";
const RE_FRACCION_PALABRA = new RegExp(`fracci[oó]n(?:es)?\\s+(${ROMANO}(?:\\s*(?:,|y|e)\\s*${ROMANO})*)\\b`, "gi");
const RE_FRACCION_SUFIJO = new RegExp(`\\b\\d+(?:-[A-Z]+)?-(${ROMANO})\\b`, "g");

/** Fracciones (números romanos) que la respuesta menciona: «fracción V», «fracciones III y XVIII», «27-III». Puro. */
export function fraccionesMencionadas(texto: string): Set<string> {
  const out = new Set<string>();
  for (const m of texto.matchAll(RE_FRACCION_PALABRA)) {
    for (const f of m[1].split(/\s*(?:,|\by\b|\be\b)\s*/)) if (/^[IVXLC]+$/.test(f)) out.add(f);
  }
  for (const m of texto.matchAll(RE_FRACCION_SUFIJO)) out.add(m[1]);
  return out;
}

/** ¿La parte contiene el arranque de alguna de estas fracciones («V. …» al inicio de línea)? Puro. */
function parteTieneFraccion(parte: string, fracciones: Set<string>): boolean {
  if (fracciones.size === 0) return false;
  for (const line of parte.split("\n")) {
    const m = line.match(/^\s*([IVXLC]+)\.\s/);
    if (m && fracciones.has(m[1])) return true;
  }
  return false;
}

/**
 * Texto de una unidad legal para el verificador. Si cabe completa, va completa;
 * si no, se conservan la primera parte (encabezado/preámbulo) y las partes que
 * traen las fracciones que la respuesta menciona, y se marca como recortada.
 * Puro.
 */
export function seleccionarTexto(partes: string[], fracciones: Set<string>, max: number = FUENTE_MAX): { texto: string; completo: boolean } {
  const todo = partes.join("\n");
  if (todo.length <= max) return { texto: todo, completo: true };
  const elegidas = new Set<number>();
  let total = 0;
  const push = (i: number) => {
    if (elegidas.has(i)) return true;
    if (total + partes[i].length + 1 > max) return false;
    elegidas.add(i);
    total += partes[i].length + 1;
    return true;
  };
  // 1) encabezado/preámbulo; 2) las partes de las fracciones mencionadas;
  // 3) lo que quepa, en orden. Se entrega en orden del documento.
  if (partes.length > 0 && partes[0].length <= max) push(0);
  partes.forEach((p, i) => {
    if (i > 0 && parteTieneFraccion(p, fracciones)) push(i);
  });
  for (let i = 1; i < partes.length; i++) if (!push(i)) break;
  const texto = [...elegidas].sort((a, b) => a - b).map((i) => partes[i]).join("\n");
  const omitidos = Math.max(todo.length - texto.length, 0);
  return { texto: `${texto}\n[… texto recortado: faltan ~${omitidos} caracteres de esta unidad]`, completo: false };
}

/**
 * ¿Se acepta la versión corregida? No si agrega citas que la respuesta original
 * no tenía (el corrector no puede aportar fundamentos de memoria) ni si encoge
 * la respuesta por debajo de CORRECCION_MIN_RATIO. Devuelve el motivo del
 * rechazo o null si es aceptable. Puro.
 */
export function motivoRechazoCorreccion(original: string, corregida: string): string | null {
  const antes = new Set(extraerCitas(original).map(claveCita));
  const nuevas = extraerCitas(corregida).map(claveCita).filter((c) => !antes.has(c));
  if (nuevas.length > 0) return `agrega citas nuevas: ${nuevas.join(", ")}`;
  if (corregida.length < original.length * CORRECCION_MIN_RATIO) return `encoge la respuesta a ${Math.round((corregida.length / Math.max(original.length, 1)) * 100)} %`;
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

const SYSTEM = `Eres un contador fiscalista senior mexicano que REVISA la respuesta de un asistente antes de que llegue al cliente. Recibes la pregunta, la respuesta, y el TEXTO REAL de cada artículo/regla que la respuesta cita. Tu trabajo es detectar afirmaciones que los textos CONTRADICEN: una fracción atribuida al artículo equivocado, un plazo, monto, tasa, fecha de reforma o vigencia distinto del que dice el texto, un requisito que el texto niega.
Reglas:
- Cada texto viene marcado como [COMPLETO] o [RECORTADO]. En un texto RECORTADO, que algo NO aparezca NO es problema (puede estar en la parte que no ves). Sólo en un texto COMPLETO cuenta como problema que la respuesta atribuya al artículo una fracción, monto, fecha o plazo que no está en él.
- Sólo son problema las afirmaciones ATRIBUIDAS a una cita cuyo texto tienes. Lo que no se atribuye a ninguna cita, o se atribuye a una cita marcada como NO VERIFICABLE, no lo juzgues: sólo asegúrate de que en la versión corregida quede señalado como «no verificado en la base».
- Interpretaciones razonables, cálculos derivados y resúmenes fieles NO son problema. Ante la duda, NO es problema. Espera que la mayoría de las respuestas estén bien: {"ok": true}.
- No opines sobre estilo ni completes la respuesta. No agregues fundamentos ni citas nuevas: la versión corregida sólo puede citar lo que la respuesta original ya citaba.
- Si todo se sostiene: {"ok": true, "problemas": [], "respuestaCorregida": null}.
- Si hay problemas: {"ok": false, "problemas": [{"afirmacion": "...", "cita": "Art. X LEY", "motivo": "una línea: qué dice el texto en realidad"}], "respuestaCorregida": "la MISMA respuesta, con cada afirmación insostenible retirada o reescrita como «no pude verificarlo en el texto del Art. X»; todo lo demás idéntico, mismo formato y extensión"}.
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
    const { sostenidas, faltantes } = clasificarCitas(citas, input.fuentes.map((f) => f.cita));
    const fracciones = fraccionesMencionadas(input.respuesta);
    // Lo que devolvió la búsqueda en el turno son PARTES; se usa sólo como
    // respaldo cuando la unidad completa no se puede traer.
    const respaldo = new Map<string, FuenteVerificacion>();
    for (const f of input.fuentes) {
      const k = claveCita(f.cita);
      const prev = respaldo.get(k);
      respaldo.set(k, prev ? { cita: prev.cita, texto: `${prev.texto}\n${f.texto}` } : f);
    }
    const bloques: string[] = [];
    const noVerificables: string[] = [];
    let total = 0;
    const agregar = (cita: string, partes: string[]) => {
      const sel = seleccionarTexto(partes, fracciones);
      if (total + sel.texto.length > FUENTES_TOTAL_MAX) return;
      total += sel.texto.length;
      bloques.push(`### ${cita} ${sel.completo ? "[COMPLETO]" : "[RECORTADO]"}\n${sel.texto}`);
    };
    for (const c of [...sostenidas, ...faltantes]) {
      const ref = parsearCita(c);
      const art = ref ? await getArticulo(ref.clave, ref.articulo, input.fechaVigencia) : null;
      if (art) {
        agregar(art.cita, art.partes.map((p) => p.texto));
        continue;
      }
      const chunk = respaldo.get(claveCita(c));
      if (chunk) agregar(chunk.cita, [chunk.texto]);
      else noVerificables.push(c);
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

    const rechazo = !v.ok && v.respuestaCorregida !== null ? motivoRechazoCorreccion(input.respuesta, v.respuestaCorregida) : null;
    const usarCorregida = !v.ok && v.respuestaCorregida !== null && rechazo === null;
    if (rechazo) console.warn("[ai.verificacion] corrección descartada:", rechazo);
    return {
      texto: usarCorregida ? v.respuestaCorregida! : input.respuesta,
      verificada: true,
      corregida: usarCorregida,
      problemas: v.problemas,
      citasNoVerificables: noVerificables,
      ...(rechazo ? { descartada: rechazo } : {}),
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
