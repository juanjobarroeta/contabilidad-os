// ─────────────────────────────────────────────────────────────────────────────
// Eval del copiloto fiscal — la brújula de todo lo demás.
//
// Por cada pregunta dorada mide TRES cosas, de lo más barato a lo más caro:
//   1. RECUPERACIÓN (sin LLM): ¿la KB devuelve alguno de los fundamentos
//      esperados en su top-6? Aísla «no lo encontró» de «lo ignoró».
//   2. RESPUESTA (el agente REAL: mismo modelo, mismo system prompt, sólo la
//      tool de KB): ¿cita fundamento? ¿cita artículos que la KB NO devolvió?
//      (= inventados, medible con regex, sin juez).
//   3. JUEZ (LLM): lo que una regex no ve — si el fundamento se usó bien y si
//      responde lo preguntado.
//
// Corre desde /api/admin/copiloto-eval (paginado, dentro de Railway donde vive
// la KB) o desde `npm run copiloto:eval` con DATABASE_URL. Todo el costo LLM
// se mide en CostEvent con subtipo "ai.eval".
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import { meteredCreate } from "@/lib/costos/anthropic";
import { buildSystemPrompt } from "@/lib/ai/system-prompt";
import { tools } from "@/lib/ai/tools";
import { executeToolCall } from "@/lib/ai/tool-executor";
import { fuentesDesdeToolResult, verificarRespuesta, type FuenteVerificacion } from "@/lib/ai/verificacion";
import { searchFiscalKnowledge } from "@/lib/fiscal-kb/search";
import type { PreguntaEval } from "./preguntas";

type VerificacionEval = NonNullable<ResultadoPregunta["respuesta"]>["verificacion"];
import { algunaCoincide, extraerCitas, claveCita, valoresPresentes, type ResultadoPregunta } from "./medidas";

export { normalizarCita, extraerCitas, algunaCoincide, resumir, type ResultadoPregunta, type ResumenEval } from "./medidas";

const CHAT_MODEL = process.env.AI_CHAT_MODEL ?? "claude-fable-5";
const CHAT_MODEL_FALLBACK = "claude-opus-4-8";
const JUEZ_MODEL = process.env.AI_EVAL_JUDGE_MODEL ?? "claude-opus-5";
const MAX_ROUNDS = 4;

/** Contribuyente sintético por régimen: el eval no toca datos de ninguna empresa real. */
const EMPRESA_EVAL: Record<NonNullable<PreguntaEval["regimen"]>, Parameters<typeof buildSystemPrompt>[0]> = {
  "601": { rfc: "EVA010101AAA", razonSocial: "Empresa de Evaluación, S.A. de C.V.", regimenFiscal: "601 General de Ley Personas Morales", codigoPostal: "06600" },
  "612": { rfc: "EVAJ800101AAA", razonSocial: "Juan Evaluación Pérez", regimenFiscal: "612 Personas Físicas con Actividades Empresariales y Profesionales", codigoPostal: "06600" },
  "626": { rfc: "EVAJ800101AAA", razonSocial: "Juan Evaluación Pérez", regimenFiscal: "626 Régimen Simplificado de Confianza", codigoPostal: "06600" },
};

// ── 1. Recuperación ───────────────────────────────────────────────────────────

export async function medirRecuperacion(p: PreguntaEval, busqueda: OpcionesBusquedaEval = {}): Promise<ResultadoPregunta["recuperacion"]> {
  const r = await searchFiscalKnowledge(p.pregunta, { modo: busqueda.modo, rerank: busqueda.rerank, candidatosRerank: busqueda.candidatos });
  const citas = r.resultados.map((h) => h.cita);
  return { hit: algunaCoincide(p.fundamentos, citas), citas, busqueda: r.busqueda };
}

// ── 2. Respuesta del agente real ──────────────────────────────────────────────

async function crear(client: Anthropic, params: Omit<Anthropic.MessageCreateParamsNonStreaming, "model">) {
  try {
    return await meteredCreate(client, { companyId: null, subtipo: "ai.eval" }, { ...params, model: CHAT_MODEL });
  } catch (err) {
    if (err instanceof Anthropic.NotFoundError) {
      return await meteredCreate(client, { companyId: null, subtipo: "ai.eval" }, { ...params, model: CHAT_MODEL_FALLBACK });
    }
    throw err;
  }
}

export async function responderComoAgente(
  client: Anthropic,
  p: PreguntaEval,
  opts: { verificar?: boolean } = {}
): Promise<{ texto: string; citasKB: string[]; rondas: number; ms: number; verificacion?: VerificacionEval }> {
  const t0 = Date.now();
  const empresa = EMPRESA_EVAL[p.regimen ?? "601"];
  const system = buildSystemPrompt(empresa);
  const kbTool = tools.find((t) => t.name === "search_fiscal_knowledge");
  if (!kbTool) throw new Error("search_fiscal_knowledge no está registrada");
  // get_articulo (Fase 2): el agente puede SEGUIR una referencia («artículo 27
  // de la Ley») en vez de citarla de memoria; lo que trae cuenta como
  // fundamento de la KB. Ninguna otra tool: sin acceso a datos de empresa.
  const artTool = tools.find((t) => t.name === "get_articulo");
  // get_valor_fiscal (tablas vigentes): puro sobre el repo, sin datos de empresa.
  const valorTool = tools.find((t) => t.name === "get_valor_fiscal");
  const herramientas = [kbTool, artTool, valorTool].filter((t): t is NonNullable<typeof t> => !!t);

  let messages: Anthropic.MessageParam[] = [{ role: "user", content: p.pregunta }];
  const citasKB: string[] = [];
  const fuentes: FuenteVerificacion[] = [];
  let texto = "";
  let rondas = 0;

  while (rondas <= MAX_ROUNDS) {
    // Fable 5 piensa siempre y sus tokens cuentan contra max_tokens: con 2048
    // parte de las respuestas «sin cita» eran cortes.
    const res = await crear(client, { max_tokens: 8192, system, tools: herramientas, messages });
    texto = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
    const usos = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (usos.length === 0 || res.stop_reason !== "tool_use") break;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const u of usos) {
      // companyId "eval": la tool de KB lo ignora (es ley, no datos de empresa);
      // ninguna otra tool está expuesta, así que no hay acceso a datos reales.
      const out = await executeToolCall(u.name, u.input as Record<string, unknown>, "eval", { inApp: false });
      fuentes.push(...fuentesDesdeToolResult(u.name, out));
      try {
        const parsed = JSON.parse(out) as { resultados?: { cita: string }[]; cita?: string };
        for (const h of parsed.resultados ?? []) citasKB.push(h.cita);
        if (typeof parsed.cita === "string") citasKB.push(parsed.cita); // get_articulo / get_valor_fiscal
      } catch {
        /* sin fundamentos en este resultado */
      }
      results.push({ type: "tool_result", tool_use_id: u.id, content: out });
    }
    messages = [...messages, { role: "assistant", content: res.content }, { role: "user", content: results }];
    rondas++;
  }
  if (!opts.verificar) return { texto, citasKB, rondas, ms: Date.now() - t0 };
  // Fase 3: la misma verificación que corre en el chat; el juez califica la
  // versión corregida, que es la que el usuario vería.
  const v = await verificarRespuesta(client, { pregunta: p.pregunta, respuesta: texto, fuentes, cost: { companyId: null, subtipo: "ai.eval" } });
  return {
    texto: v.texto,
    citasKB,
    rondas,
    ms: Date.now() - t0,
    verificacion: { verificada: v.verificada, corregida: v.corregida, problemas: v.problemas, citasNoVerificables: v.citasNoVerificables, ms: v.ms },
  };
}

// ── 3. Juez ───────────────────────────────────────────────────────────────────

const JUEZ_SYSTEM = `Eres un contador fiscalista senior mexicano que califica respuestas de un asistente fiscal. Recibes la pregunta, los fundamentos que un contador experto citaría, los fundamentos que la base de conocimiento devolvió y la respuesta. Responde SOLO un JSON con esta forma exacta:
{"fundamentoCorrecto": bool, "noInventa": bool, "respondeLoPreguntado": bool, "comentario": "una línea"}
- fundamentoCorrecto: la respuesta se apoya en el fundamento correcto (alguno de los esperados o uno equivalente igual de válido) y lo interpreta bien.
- noInventa: no afirma artículos, tasas, plazos o requisitos que no estén sostenidos por los fundamentos devueltos. Decir «no encontré fundamento» cuenta como no inventar.
- respondeLoPreguntado: contesta la pregunta concreta, no una vecina.
Sé estricto: un contador que cita el artículo equivocado con seguridad es peor que uno que dice que no sabe.`;

export async function juzgar(
  client: Anthropic,
  p: PreguntaEval,
  respuesta: string,
  citasKB: string[]
): Promise<ResultadoPregunta["juez"]> {
  const user = `Pregunta: ${p.pregunta}
Fundamentos esperados: ${p.fundamentos.join(" | ")}${p.nota ? `\nNota del revisor: ${p.nota}` : ""}
Fundamentos que la KB devolvió: ${citasKB.length ? [...new Set(citasKB)].join(" | ") : "(ninguno)"}

Respuesta a calificar:
"""
${respuesta.slice(0, 6000)}
"""`;
  const res = await meteredCreate(
    client,
    { companyId: null, subtipo: "ai.eval" },
    // Opus 5 piensa por default y esos tokens cuentan contra max_tokens: con
    // 600, 46 de 80 veredictos salieron cortados a mitad del JSON o vacíos.
    // No se apaga el pensamiento (en Opus 5 filtra tags y mete tools en el
    // texto): se baja el esfuerzo y se da aire.
    {
      model: JUEZ_MODEL,
      max_tokens: 4000,
      output_config: { effort: "low" },
      system: JUEZ_SYSTEM,
      messages: [{ role: "user", content: user }],
    }
  );
  const texto = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  const m = /\{[\s\S]*\}/.exec(texto);
  if (!m) throw new Error(`Juez sin JSON: ${texto.slice(0, 120)}`);
  const j = JSON.parse(m[0]) as Record<string, unknown>;
  return {
    fundamentoCorrecto: j.fundamentoCorrecto === true,
    noInventa: j.noInventa === true,
    respondeLoPreguntado: j.respondeLoPreguntado === true,
    comentario: typeof j.comentario === "string" ? j.comentario : "",
  };
}

// ── Orquestación ──────────────────────────────────────────────────────────────

/** Palancas de la búsqueda que el eval mide por separado (Fase 2). Vacío = defaults de producción. */
export interface OpcionesBusquedaEval {
  modo?: "vector" | "hibrido";
  rerank?: boolean;
  /** Candidatos que lee el rerank (6–40). */
  candidatos?: number;
  /** Fase 3: correr el pase de verificación sobre la respuesta del agente. */
  verificar?: boolean;
}

export interface OpcionesEval {
  /** Correr el agente (cuesta tokens). Default true. */
  agente?: boolean;
  /** Correr el juez (cuesta tokens; requiere agente). Default true. */
  juez?: boolean;
  busqueda?: OpcionesBusquedaEval;
}

export async function evaluarPregunta(p: PreguntaEval, opts: OpcionesEval = {}, client = new Anthropic()): Promise<ResultadoPregunta> {
  const base: ResultadoPregunta = {
    id: p.id,
    tema: p.tema,
    pregunta: p.pregunta,
    fundamentos: p.fundamentos,
    recuperacion: { hit: false, citas: [] },
  };
  try {
    base.recuperacion = await medirRecuperacion(p, opts.busqueda ?? {});
    if (opts.agente === false) return base;

    const r = await responderComoAgente(client, p, { verificar: opts.busqueda?.verificar === true });
    const citasEnTexto = extraerCitas(r.texto);
    const kb = new Set(r.citasKB.map(claveCita));
    base.respuesta = {
      texto: r.texto,
      citasEnTexto,
      citasFueraDeKB: citasEnTexto.filter((c) => !kb.has(claveCita(c))),
      citaPresente: citasEnTexto.length > 0,
      ...(p.valoresEsperados?.length ? { valorCorrecto: valoresPresentes(r.texto, p.valoresEsperados) } : {}),
      rondas: r.rondas,
      ms: r.ms,
      verificacion: r.verificacion,
    };
    if (opts.juez === false) return base;
    base.juez = await juzgar(client, p, r.texto, r.citasKB);
  } catch (err) {
    base.error = err instanceof Error ? err.message : String(err);
  }
  return base;
}
