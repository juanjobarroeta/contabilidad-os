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
// `verificada: false`. Costo: un llamado a Haiku, subtipo "ai.verificacion"
// (o el que mande quien llama: el jurídico usa "ai.juridico.verificacion").
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import { meteredCreate } from "@/lib/costos/anthropic";
import type { CostCtx } from "@/lib/costos/record";
import { getArticulo } from "@/lib/fiscal-kb/search";
import { citasConPosicion, claveCita, extraerCitas } from "@/lib/ai/eval/medidas";
import { citasEnProsa, type EntradaIndice } from "@/lib/ai/citas-prosa";
import { ESTADOS } from "@/lib/fiscal-kb/catalogo/ojn";

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

/** Prefijo de las fuentes que vienen de get_valor_fiscal (tablas vigentes del sistema). */
export const PREFIJO_VALORES = "Valores oficiales";

export interface ProblemaVerificacion {
  afirmacion: string;
  cita: string;
  motivo: string;
}

/** La norma concreta en que descansa una cita (lo que el panel debe abrir). */
export interface FundamentoCita {
  /** Cita canónica de la fuente: «Art. 486 CHH-C-PROCEDIMIENTOS-FAMILIARES-CH». */
  cita: string;
  ley?: string;
  articulo?: string;
  titulo?: string;
  url?: string;
}

/** Estado de UNA cita de la respuesta, para pintarla y explicarla. */
export type EstadoCita = "verificada" | "corregida" | "observada" | "fuera_de_base" | "sin_verificar";

export interface CitaEnRespuesta {
  /** Estable dentro del mensaje: «c1», «c2»… */
  id: string;
  /** Offsets en el TEXTO ENTREGADO (el corregido, si hubo corrección). */
  inicio: number;
  fin: number;
  textoEnRespuesta: string;
  /** Normalizada: «ART. 486 CPF». */
  cita: string;
  fundamento: FundamentoCita | null;
  estado: EstadoCita;
  /** Por qué el verificador la marcó (sólo en «corregida» y «observada»). */
  motivo?: string;
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
  /** Con qué norma se resolvió cada cita del texto (null = no se encontró). */
  resueltas: { cita: string; fundamento: FundamentoCita | null }[];
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
  // La clave puede ser federal («LISR») o estatal con guiones
  // («CHH-C-PROCEDIMIENTOS-FAMILIARES-CH»), que es lo que produce citas-prosa.
  const m = cita.trim().match(/^(?:ART\.?|ARTÍCULO)\s+([0-9][0-9A-Za-z-]*(?:\s+BIS)?)\s+([A-Z][A-Z0-9-]*)$/i);
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
- Los bloques «Valores oficiales» son las tablas vigentes del sistema (Anexo 5 y 8 de la RMF, LIF, INEGI): montos de multas, tarifas, UMA, salario mínimo, recargos o subsidio que coincidan con ellos están SOSTENIDOS aunque el artículo citado traiga otra cifra (la ley trae montos nominales; el Anexo los actualiza) y aunque tu memoria diga otra cosa. Nunca uses tus propios valores para juzgar cifras.
- Interpretaciones razonables, cálculos derivados y resúmenes fieles NO son problema. Ante la duda, NO es problema. Espera que la mayoría de las respuestas estén bien: {"ok": true}.
- No opines sobre estilo ni completes la respuesta. No agregues fundamentos ni citas nuevas: la versión corregida sólo puede citar lo que la respuesta original ya citaba.
- Si todo se sostiene: {"ok": true, "problemas": [], "respuestaCorregida": null}.
- Si hay problemas: {"ok": false, "problemas": [{"afirmacion": "...", "cita": "Art. X LEY", "motivo": "una línea: qué dice el texto en realidad"}], "respuestaCorregida": "la MISMA respuesta, con cada afirmación insostenible retirada o reescrita como «no pude verificarlo en el texto del Art. X»; todo lo demás idéntico, mismo formato y extensión"}.
Responde ÚNICAMENTE el JSON.`;

export async function verificarRespuesta(
  client: Anthropic,
  input: { pregunta: string; respuesta: string; fuentes: FuenteVerificacion[]; cost?: CostCtx; fechaVigencia?: Date; indiceOrdenamientos?: EntradaIndice[] }
): Promise<ResultadoVerificacion> {
  const t0 = Date.now();
  const original: ResultadoVerificacion = { texto: input.respuesta, verificada: false, corregida: false, problemas: [], citasNoVerificables: [], resueltas: [], ms: 0 };
  // Las de forma corta («Art. 27 LISR») y las escritas en prosa («el artículo
  // 486 del Código de Procedimientos Familiares del Estado de Chihuahua»), que
  // es como el jurídico nombra casi todo.
  const enProsa = input.indiceOrdenamientos ? citasEnProsa(input.respuesta, input.indiceOrdenamientos).map((c) => c.cita) : [];
  const citas = [...new Set([...extraerCitas(input.respuesta), ...enProsa])];
  if (citas.length === 0) return original;

  try {
    const { sostenidas, faltantes } = clasificarCitas(citas, input.fuentes.map((f) => f.cita));
    const fracciones = fraccionesMencionadas(input.respuesta);
    // Lo que devolvió la búsqueda en el turno son PARTES; se usa sólo como
    // respaldo cuando la unidad completa no se puede traer.
    const respaldo = new Map<string, FuenteVerificacion>();
    for (const f of input.fuentes) {
      if (f.cita.startsWith(PREFIJO_VALORES)) continue;
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
    // Las tablas de valores (get_valor_fiscal) entran siempre, completas: son
    // la fuente de los montos y no se citan como artículo.
    for (const f of input.fuentes) {
      if (f.cita.startsWith(PREFIJO_VALORES)) agregar(f.cita, [f.texto]);
    }
    const resueltas: { cita: string; fundamento: FundamentoCita | null }[] = [];
    for (const c of [...sostenidas, ...faltantes]) {
      // «Art. 486 CPF Chihuahua»: el abogado cita el código estatal por sus
      // siglas + estado; la KB lo tiene como CHH-C-PROCEDIMIENTOS-FAMILIARES-CH.
      // Se resuelve contra lo que las herramientas ya trajeron, ANTES de
      // buscar «CPF» (Código Penal Federal) en la base.
      const estatal = resolverCitaEstatal(c, input.respuesta, [...respaldo.values()]);
      if (estatal) {
        agregar(estatal.cita, [estatal.texto]);
        resueltas.push({ cita: c, fundamento: { cita: estatal.cita } });
        continue;
      }
      const ref = parsearCita(c);
      const art = ref ? await getArticulo(ref.clave, ref.articulo, input.fechaVigencia) : null;
      if (art) {
        agregar(art.cita, art.partes.map((p) => p.texto));
        resueltas.push({ cita: c, fundamento: { cita: art.cita, ley: art.ley, articulo: art.articulo, titulo: art.titulo, url: art.url } });
        continue;
      }
      const chunk = respaldo.get(claveCita(c));
      if (chunk) {
        agregar(chunk.cita, [chunk.texto]);
        resueltas.push({ cita: c, fundamento: { cita: chunk.cita } });
      } else {
        noVerificables.push(c);
        resueltas.push({ cita: c, fundamento: null });
      }
    }

    const user = `Pregunta del cliente:\n${input.pregunta}\n\nRespuesta a revisar:\n"""\n${input.respuesta}\n"""\n\nCitas NO VERIFICABLES (no existen en la base; sólo márcalas): ${noVerificables.length ? noVerificables.join(" | ") : "(ninguna)"}\n\nTextos reales de las citas:\n\n${bloques.join("\n\n") || "(ninguno)"}`;

    const msg = await meteredCreate(
      client,
      // El subtipo de quien llama manda: el jurídico manda «ai.juridico.verificacion»
      // y sin esto caía en «ai.verificacion», fuera de su medición y de su tope.
      { companyId: null, subtipo: "ai.verificacion", ...input.cost },
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
      resueltas,
      ...(rechazo ? { descartada: rechazo } : {}),
      ms: Date.now() - t0,
    };
  } catch (err) {
    console.error("[ai.verificacion] falló, se entrega la respuesta original:", err instanceof Error ? err.message : err);
    return { ...original, ms: Date.now() - t0 };
  }
}

/** Fuentes de un turno a partir de los JSON que devolvieron las tools de la KB. */
/**
 * Una cita del tipo «Art. 486 CPF Chihuahua» (siglas federales + nombre del
 * estado, o «del Estado de Chihuahua») se resuelve contra la fuente estatal
 * que las herramientas ya devolvieron para ese artículo (clave «CHH-…»).
 * Sin estado junto a la cita, o sin fuente de ese estado, devuelve null y la
 * cita sigue el camino normal. Puro (no consulta la base).
 */
export function resolverCitaEstatal(cita: string, respuesta: string, fuentes: FuenteVerificacion[]): FuenteVerificacion | null {
  const ref = parsearCita(cita);
  if (!ref) return null;
  const numero = ref.articulo.replace(/[.\-]/g, "[.\\-]?").replace(/\s+/g, "\\s*");
  const re = new RegExp(String.raw`\bart(?:[íi]culo|\.)?\s*${numero}\s*(?:,?\s*(?:fracci[óo]n\s+[IVXL]+\s*)?)?(?:de\s+la\s+|del\s+)?${ref.clave}\b[\s,]*(?:(?:de|del|para)\s+(?:el\s+)?(?:estado\s+(?:libre\s+y\s+soberano\s+)?de\s+)?)?([A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]+){0,3})`, "gi");
  const sinAcentos = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  for (const m of respuesta.matchAll(re)) {
    const cola = sinAcentos(m[1]);
    const estado = ESTADOS.find((e) => cola.startsWith(sinAcentos(e.nombre)) || cola.startsWith(sinAcentos(e.nombre.split(" de ")[0])) || cola === e.sat.toLowerCase());
    if (!estado) continue;
    const prefijo = `${estado.sat}-`;
    for (const f of fuentes) {
      const fr = parsearCitaEstatal(f.cita);
      if (fr && fr.clave.startsWith(prefijo) && fr.articulo.toUpperCase() === ref.articulo.toUpperCase()) return f;
    }
  }
  return null;
}

/** «Art. 486 CHH-C-PROCEDIMIENTOS-FAMILIARES-CH» → clave con guiones (parsearCita sólo admite letras). */
function parsearCitaEstatal(cita: string): { clave: string; articulo: string } | null {
  const m = cita.trim().match(/^(?:ART\.?|ARTÍCULO)\s+([0-9][0-9A-Za-z-]*(?:\s+BIS)?)\s+([A-Z]{3}-[A-Z0-9-]+)$/i);
  return m ? { clave: m[2].toUpperCase(), articulo: m[1] } : null;
}

/**
 * Las citas de la respuesta ENTREGADA, cada una con su lugar, su norma y su
 * veredicto. Es lo que la UI necesita para que una cita sea clicable y el
 * panel abra el artículo o la tesis exacta en que descansa.
 *
 * Puro y barato: los offsets salen del regex sobre el texto final, así que no
 * hay pasada extra del modelo ni mapa de posiciones que mantener. Si la
 * verificación corrigió el texto, se corre sobre el corregido y los offsets
 * ya corresponden a lo que el abogado lee.
 *
 * Límite conocido: sólo reconoce citas con forma de cita («artículo 486 del
 * CPF», «regla 2.7.1.32», «reg. 2021760»). Una cita en prosa —«el Código de
 * Procedimientos Familiares de Chihuahua»— no genera marca.
 */
export function construirCitas(args: {
  texto: string;
  /** Lo que devolvieron las herramientas del turno (respaldo cuando no hubo verificación). */
  fuentes: { cita: string; texto?: string }[];
  /** Con él se marcan también las citas escritas en prosa. */
  indiceOrdenamientos?: EntradaIndice[];
  resueltas?: { cita: string; fundamento: FundamentoCita | null }[];
  problemas?: ProblemaVerificacion[];
  citasNoVerificables?: string[];
  verificada: boolean;
  corregida: boolean;
}): CitaEnRespuesta[] {
  const porClave = new Map<string, FundamentoCita | null>();
  for (const f of args.fuentes) {
    if (f.cita.startsWith(PREFIJO_VALORES)) continue;
    const k = claveCita(f.cita);
    if (!porClave.has(k)) porClave.set(k, { cita: f.cita });
  }
  for (const r of args.resueltas ?? []) porClave.set(claveCita(r.cita), r.fundamento);

  const problemaPorClave = new Map<string, string>();
  for (const p of args.problemas ?? []) {
    if (!p.cita) continue;
    const k = claveCita(p.cita);
    if (!problemaPorClave.has(k)) problemaPorClave.set(k, p.motivo || p.afirmacion);
  }
  const fuera = new Set((args.citasNoVerificables ?? []).map(claveCita));

  // Sin pase de verificación, una cita estatal («Art. 486 CPF Chihuahua») no
  // casa por clave con su fuente («…CHH-C-PROCEDIMIENTOS-FAMILIARES-CH»): se
  // resuelve igual que en el pase, por siglas + estado.
  const conTexto: FuenteVerificacion[] = args.fuentes.filter((f) => !f.cita.startsWith(PREFIJO_VALORES)).map((f) => ({ cita: f.cita, texto: f.texto ?? "" }));

  const enProsa = args.indiceOrdenamientos ? citasEnProsa(args.texto, args.indiceOrdenamientos).map((c) => ({ cita: c.cita, textoEnRespuesta: c.textoEnRespuesta, inicio: c.inicio, fin: c.fin })) : [];
  const ubicadas = [...citasConPosicion(args.texto), ...enProsa]
    .sort((a, b) => a.inicio - b.inicio)
    // Una misma cita puede salir por las dos vías (corta y en prosa): se queda
    // la primera y se descarta la que se le encime.
    .filter((c, i, todas) => !todas.slice(0, i).some((p) => c.inicio < p.fin && c.fin > p.inicio));

  return ubicadas.map((u, i) => {
    const k = claveCita(u.cita);
    let fundamento = porClave.get(k) ?? null;
    if (!fundamento && !porClave.has(k)) {
      const estatal = resolverCitaEstatal(u.cita, args.texto, conTexto);
      if (estatal) fundamento = { cita: estatal.cita };
    }
    const motivo = problemaPorClave.get(k);
    let estado: EstadoCita;
    if (fuera.has(k) || (args.verificada && !fundamento)) estado = "fuera_de_base";
    else if (!args.verificada) estado = "sin_verificar";
    else if (motivo) estado = args.corregida ? "corregida" : "observada";
    else estado = "verificada";
    return { id: `c${i + 1}`, inicio: u.inicio, fin: u.fin, textoEnRespuesta: u.textoEnRespuesta, cita: u.cita, fundamento, estado, ...(motivo ? { motivo } : {}) };
  });
}

export function fuentesDesdeToolResult(toolName: string, out: string): FuenteVerificacion[] {
  try {
    const parsed = JSON.parse(out) as { resultados?: { cita: string; texto: string }[]; cita?: string; partes?: { texto: string }[]; texto?: string; tipo?: string; error?: string };
    if (toolName === "search_fiscal_knowledge" || toolName === "search_jurisprudencia") return (parsed.resultados ?? []).map((h) => ({ cita: h.cita, texto: h.texto }));
    if (toolName === "get_articulo" && typeof parsed.cita === "string") return [{ cita: parsed.cita, texto: (parsed.partes ?? []).map((p) => p.texto).join("\n") }];
    if (toolName === "get_tesis" && typeof parsed.cita === "string" && typeof parsed.texto === "string") return [{ cita: parsed.cita, texto: parsed.texto }];
    if (toolName === "get_valor_fiscal" && typeof parsed.tipo === "string" && !parsed.error) {
      return [{ cita: `${PREFIJO_VALORES} · ${parsed.tipo}`, texto: JSON.stringify(parsed, null, 1) }];
    }
  } catch {
    /* sin fuentes en este resultado */
  }
  return [];
}
