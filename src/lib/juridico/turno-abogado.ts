// ─────────────────────────────────────────────────────────────────────────────
// El turno del copiloto jurídico (perfil abogado): rondas de herramientas en
// streaming, redacción, asunto, verificación de citas y persistencia de la
// respuesta. Vive fuera de la ruta HTTP para que un turno pueda CONTINUAR en
// otro proceso: recibe un checkpoint (mensajes del API, rondas, texto,
// fuentes, traza) y guarda uno nuevo al cerrar cada ronda.
//
// Lo usan POST /api/juridico/chat (turno nuevo) y turnos-reanudar.ts (turno
// huérfano de un contenedor que murió).
// ─────────────────────────────────────────────────────────────────────────────
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { toolsAbogado } from "@/lib/ai/tools-abogado";
import { ejecutarHerramientaAbogado } from "@/lib/ai/executor-abogado";
import { buildSystemPromptAbogado } from "@/lib/ai/system-prompt-abogado";
import { recordLlmCost } from "@/lib/costos/record";
import { construirCitas, fuentesDesdeToolResult, verificarRespuesta, type CitaEnRespuesta, type FuenteVerificacion } from "@/lib/ai/verificacion";
import { bloqueDocumentosParaPrompt, toolsDocumentos, type DocumentoCargado, type Resumenes, type Seccion } from "@/lib/juridico/documentos";
import { ejecutarRedactar, toolRedactar } from "@/lib/juridico/redaccion";
import { asuntoDeConversacion, bloqueAsuntoParaPrompt, ejecutarHerramientaAsunto, toolsAsunto, type Asunto } from "@/lib/juridico/asuntos";
import { NOMBRES_REDACCION_ESTRUCTURADA, ejecutarRedaccionEstructurada, toolsRedaccionEstructurada } from "@/lib/juridico/redaccion-estructurada";
import { NOMBRES_TAREAS, ejecutarHerramientaTareas, toolsTareas } from "@/lib/juridico/tareas-tool";
import { NOMBRES_PLAZOS, ejecutarHerramientaPlazos, toolsPlazos } from "@/lib/juridico/plazos-tool";
import { reportError } from "@/lib/observability";
import { mensajeDeErrorParaAbogado } from "@/lib/juridico/errores";
import { indiceOrdenamientos } from "@/lib/juridico/indice-ordenamientos";
import type { CheckpointTurno, EventoTurno } from "@/lib/juridico/turnos";

const anthropic = new Anthropic();

// Revisar un contrato pide muchas consultas (varios artículos, jurisprudencia);
// si se agotan, hay una última vuelta SIN herramientas para que redacte.
const MAX_TOOL_ROUNDS = 10;
const MAX_TOOL_ROUNDS_CON_DOCUMENTOS = 24;
// Un escrito entero cabe en una sola llamada a redactar_documento: con 6 144
// tokens se cortaba a la mitad (y el turno moría con «user messages must have
// non-empty content»).
const MAX_TOKENS_SALIDA = 16_000;
export const CHAT_MODEL = process.env.AI_CHAT_MODEL ?? "claude-fable-5";
const CHAT_MODEL_FALLBACK = "claude-opus-4-8";

export interface Traza {
  modelo: string;
  rondas: number;
  tools: { name: string; ms: number; resumen?: string }[];
  fundamentos: { cita: string; similitud: number; fuente?: string }[];
  documentos?: string[];
  verificacion?: { verificada: boolean; corregida: boolean; problemas: number; citasNoVerificables: string[]; ms: number };
  /** Cada cita de la respuesta entregada: dónde está, en qué norma descansa y su veredicto. */
  citas?: CitaEnRespuesta[];
  cacheReadTokens: number;
  reanudado?: number; // veces que el turno continuó en otro proceso
}

export interface ContextoConversacion {
  documentos: DocumentoCargado[];
  asunto: Asunto | null;
  system: Anthropic.TextBlockParam[];
  tools: Anthropic.MessageCreateParams["tools"];
  maxRondas: number;
}

/**
 * Documentos, asunto, system prompt y herramientas de una conversación. Se
 * arma igual para un turno nuevo que para uno reanudado.
 */
export async function cargarContextoConversacion(convId: string, userId: string): Promise<ContextoConversacion> {
  // Documentos de la conversación: bloque propio del system (cacheado aparte del
  // prompt base, que es igual para todas las conversaciones).
  const documentos: DocumentoCargado[] = (
    await prisma.juridicoDocumento.findMany({
      where: { conversacionId: convId },
      orderBy: { createdAt: "asc" },
      select: { id: true, nombre: true, paginas: true, caracteres: true, texto: true, secciones: true, resumenes: true },
    })
  ).map((d) => ({ ...d, secciones: (d.secciones as unknown as Seccion[] | null) ?? [], resumenes: (d.resumenes as unknown as Resumenes | null) ?? null }));
  // El asunto (partes, expediente, decisiones) viene de la base: bloque propio,
  // sin caché porque cambia dentro del mismo turno cuando el modelo registra algo.
  const asunto = await asuntoDeConversacion(convId, userId);
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: buildSystemPromptAbogado(), cache_control: { type: "ephemeral" } },
    ...(documentos.length > 0 ? [{ type: "text" as const, text: bloqueDocumentosParaPrompt(documentos), cache_control: { type: "ephemeral" as const } }] : []),
    { type: "text", text: bloqueAsuntoParaPrompt(asunto) },
  ];
  // Redactar y el asunto siempre están; leer/buscar sólo cuando hay documentos.
  const tools = [...toolsAbogado, toolRedactar, ...toolsRedaccionEstructurada, ...toolsAsunto, ...toolsTareas, ...toolsPlazos, ...(documentos.length > 0 ? toolsDocumentos : [])];
  // Un expediente se lee por secciones: hacen falta más rondas de herramientas.
  const maxRondas = documentos.length > 0 ? MAX_TOOL_ROUNDS_CON_DOCUMENTOS : MAX_TOOL_ROUNDS;
  return { documentos, asunto, system, tools, maxRondas };
}

/**
 * Marca dónde termina lo que ya se puede cachear: el ÚLTIMO bloque del último
 * mensaje. Anthropic cachea todo el prefijo hasta ahí, así que la ronda
 * siguiente lee las anteriores a una décima parte del precio en vez de
 * reenviarlas enteras.
 *
 * Por qué importa: un turno del abogado hace 7-8 llamadas y cada una reenviaba
 * TODA la conversación —artículos completos, tesis, documentos— sin caché. Con
 * uso real medido (15-sep-2026) salía a 3.04 USD por respuesta, que a diez
 * respuestas al día no lo paga ningún plan.
 *
 * El marcador es UNO y va rodando: el límite del API son cuatro por petición y
 * dos ya los usan el prompt base y los documentos. Puro.
 */
export function marcarCacheDeConversacion(mensajes: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const limpios = mensajes.map((m) => ({
    ...m,
    content: Array.isArray(m.content)
      ? m.content.map((b) => {
          if (typeof b === "string" || !("cache_control" in b)) return b;
          const { cache_control: _q, ...resto } = b as { cache_control?: unknown };
          return resto as Anthropic.ContentBlockParam;
        })
      : m.content,
  })) as Anthropic.MessageParam[];
  for (let i = limpios.length - 1; i >= 0; i--) {
    const m = limpios[i];
    if (!Array.isArray(m.content) || m.content.length === 0) continue;
    const bloques = [...m.content];
    const ultimo = bloques[bloques.length - 1];
    if (typeof ultimo === "string") continue;
    bloques[bloques.length - 1] = { ...ultimo, cache_control: { type: "ephemeral" } } as Anthropic.ContentBlockParam;
    limpios[i] = { ...m, content: bloques };
    return limpios;
  }
  return limpios;
}

function resumenDeResultado(nombre: string, out: string): string | undefined {
  try {
    const parsed = JSON.parse(out) as { resultados?: { cita: string }[]; cita?: string; error?: string; aviso?: string; resumen?: string };
    if (parsed.error) return `error: ${parsed.error.slice(0, 80)}`;
    if (typeof parsed.resumen === "string") return parsed.resumen;
    if (Array.isArray(parsed.resultados)) return parsed.resultados.length === 0 ? "sin resultados" : parsed.resultados.map((r) => r.cita).slice(0, 6).join(" · ");
    if (typeof parsed.cita === "string") return parsed.cita;
  } catch {
    /* best-effort */
  }
  return undefined;
}

export interface TurnoAbogadoArgs {
  convId: string;
  userId: string;
  convCreada: boolean;
  /** Historial que manda el cliente (sólo se usa cuando no hay checkpoint). */
  mensajesIniciales: Anthropic.MessageParam[];
  /** El mensaje del usuario, para la verificación de citas. */
  pregunta: string;
  mensajeUsuarioId: string | null;
  contexto: ContextoConversacion;
  /** Turno que continúa en este proceso: se arranca desde aquí. */
  checkpoint?: CheckpointTurno | null;
  guardarCheckpoint?: (cp: CheckpointTurno) => Promise<void>;
}

export async function correrTurnoAbogado(args: TurnoAbogadoArgs, emitir: (e: EventoTurno) => void): Promise<void> {
  const { convId, userId, contexto } = args;
  const { documentos, system, tools, maxRondas } = contexto;
  let asunto = contexto.asunto;
  const cp = args.checkpoint;
  const reanudado = !!cp && (cp.rondas > 0 || cp.texto.length > 0);
  if (reanudado) {
    // El cliente ya vio los eventos guardados (incluido texto de la ronda que
    // se interrumpió): se le deja el texto del checkpoint y se sigue desde ahí.
    emitir({ type: "replace", text: cp!.texto });
  } else {
    emitir({ type: "conversation", id: convId, nueva: args.convCreada });
  }
  let assistantText = cp?.texto ?? "";
  const trazaPrevia = (cp?.traza ?? null) as Traza | null;
  const traza: Traza = trazaPrevia
    ? { ...trazaPrevia, reanudado: (trazaPrevia.reanudado ?? 0) + 1 }
    : { modelo: CHAT_MODEL, rondas: 0, tools: [], fundamentos: [], cacheReadTokens: 0, ...(documentos.length > 0 ? { documentos: documentos.map((d) => d.nombre) } : {}) };
  const fuentesTurno: FuenteVerificacion[] = [...(cp?.fuentes ?? [])];
  const persistirAsistente = async (extra?: Record<string, unknown>) => {
    if (!assistantText.trim() && !extra) return null;
    const creado = await prisma.juridicoMensaje.create({
      data: { conversacionId: convId, rol: "assistant", contenido: assistantText, meta: JSON.parse(JSON.stringify({ ...traza, ...extra })) },
      select: { id: true },
    });
    await prisma.juridicoConversacion.update({ where: { id: convId }, data: { updatedAt: new Date() } });
    return creado.id;
  };
  const guardarCheckpoint = async (mensajes: Anthropic.MessageParam[], rondas: number) => {
    if (!args.guardarCheckpoint) return;
    try {
      await args.guardarCheckpoint({ mensajes, rondas, texto: assistantText, fuentes: fuentesTurno, traza: JSON.parse(JSON.stringify(traza)) });
    } catch (e) {
      reportError(e, { ruta: "juridico/chat", paso: "checkpoint", conversacionId: convId, rondas });
    }
  };
  try {
    let currentMessages: Anthropic.MessageParam[] = cp && Array.isArray(cp.mensajes) && cp.mensajes.length > 0 ? (cp.mensajes as Anthropic.MessageParam[]) : [...args.mensajesIniciales];
    let toolRounds = cp?.rondas ?? 0;
    let model = trazaPrevia?.modelo && trazaPrevia.modelo !== CHAT_MODEL ? trazaPrevia.modelo : CHAT_MODEL;
    let rondasAgotadas = toolRounds >= maxRondas;

    while (toolRounds < maxRondas) {
      const params: Anthropic.MessageCreateParamsStreaming = {
        model,
        max_tokens: MAX_TOKENS_SALIDA,
        system,
        tools,
        // El prefijo ya visto se lee de caché: sin esto cada ronda reenviaba
        // la conversación entera a precio completo.
        messages: marcarCacheDeConversacion(currentMessages),
        stream: true,
      };
      let response;
      try {
        response = await anthropic.messages.create(params);
      } catch (err) {
        if (model !== CHAT_MODEL_FALLBACK && err instanceof Anthropic.NotFoundError) {
          model = CHAT_MODEL_FALLBACK;
          response = await anthropic.messages.create({ ...params, model });
        } else {
          throw err;
        }
      }

      let hasToolUse = false;
      const toolUseBlocks: Anthropic.ContentBlockParam[] = [];
      let currentToolUse: { id: string; name: string; input: string } | null = null;
      let roundInput = 0;
      let roundOutput = 0;
      let roundCacheWrite = 0;
      let roundCacheRead = 0;
      let stopReason: string | null = null;
      let entradaTruncada: string | null = null;

      for await (const event of response) {
        if (event.type === "message_start") {
          roundInput = event.message.usage?.input_tokens ?? 0;
          roundCacheWrite = event.message.usage?.cache_creation_input_tokens ?? 0;
          roundCacheRead = event.message.usage?.cache_read_input_tokens ?? 0;
        } else if (event.type === "message_delta") {
          roundOutput = event.usage?.output_tokens ?? roundOutput;
          stopReason = event.delta.stop_reason ?? stopReason;
        } else if (event.type === "content_block_start") {
          if (event.content_block.type === "tool_use") {
            hasToolUse = true;
            currentToolUse = { id: event.content_block.id, name: event.content_block.name, input: "" };
            emitir({ type: "tool_start", tool: event.content_block.name });
          }
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            assistantText += event.delta.text;
            emitir({ type: "text", text: event.delta.text });
          } else if (event.delta.type === "input_json_delta" && currentToolUse) {
            currentToolUse.input += event.delta.partial_json;
          }
        } else if (event.type === "content_block_stop" && currentToolUse) {
          let parsedInput: unknown = {};
          try {
            parsedInput = JSON.parse(currentToolUse.input || "{}");
          } catch {
            // JSON a medias: la salida se cortó por max_tokens dentro de la llamada.
            parsedInput = {};
            entradaTruncada = currentToolUse.name;
          }
          toolUseBlocks.push({ type: "tool_use", id: currentToolUse.id, name: currentToolUse.name, input: parsedInput });
          currentToolUse = null;
        }
      }
      // Bloque abierto al terminar el stream (nunca llegó su stop): se cierra aquí
      // para que la ronda no mande un mensaje de usuario vacío al API.
      if (currentToolUse) {
        toolUseBlocks.push({ type: "tool_use", id: currentToolUse.id, name: currentToolUse.name, input: {} });
        entradaTruncada = currentToolUse.name;
        currentToolUse = null;
      }

      traza.cacheReadTokens += roundCacheRead;
      await recordLlmCost(
        model,
        { input_tokens: roundInput, output_tokens: roundOutput, cache_creation_input_tokens: roundCacheWrite, cache_read_input_tokens: roundCacheRead },
        { companyId: null, userId, subtipo: "ai.juridico" }
      );

      if (!hasToolUse) break;

      const llamadas = toolUseBlocks.filter((b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use");
      if (llamadas.length === 0) break; // nada que ejecutar: nunca mandar un turno de usuario vacío
      const salidas = await Promise.all(
        llamadas.map(async (block) => {
          const t0 = Date.now();
          if (entradaTruncada === block.name && stopReason === "max_tokens") {
            // La llamada se cortó por longitud: se le dice al modelo, en vez de ejecutar con {}.
            emitir({ type: "tool_done", tool: block.name, ms: 0, resumen: "llamada cortada por longitud" });
            return { block, result: JSON.stringify({ error: `La llamada a ${block.name} se cortó por longitud (max_tokens) y no se ejecutó. Vuelve a llamarla con un texto más corto o en dos documentos (p. ej. escrito y anexo).`, resumen: "cortada" }), ms: 0 };
          }
          if (block.name === "registrar_partes" || block.name === "actualizar_asunto" || block.name === "consultar_asunto") {
            const r = await ejecutarHerramientaAsunto(block.name, block.input as Record<string, unknown>, { userId, conversacionId: convId, mensajeId: args.mensajeUsuarioId });
            if (r.asunto) {
              asunto = r.asunto;
              system[system.length - 1] = { type: "text", text: bloqueAsuntoParaPrompt(asunto) };
              if (block.name !== "consultar_asunto") emitir({ type: "asunto", asunto });
            }
            return { block, result: r.salida, ms: Date.now() - t0 };
          }
          if (NOMBRES_PLAZOS.has(block.name)) {
            return { block, result: await ejecutarHerramientaPlazos(block.name, block.input as Record<string, unknown>, { userId, conversacionId: convId }), ms: Date.now() - t0 };
          }
          if (NOMBRES_TAREAS.has(block.name)) {
            return { block, result: await ejecutarHerramientaTareas(block.name, block.input as Record<string, unknown>, { userId, conversacionId: convId }), ms: Date.now() - t0 };
          }
          if (NOMBRES_REDACCION_ESTRUCTURADA.has(block.name)) {
            // Esquema → secciones → revisión → edición: avisa al cliente por SSE mientras corre.
            const r = await ejecutarRedaccionEstructurada(block.name, block.input as Record<string, unknown>, { anthropic, userId, conversacionId: convId, asunto, emitir });
            if (r.cargado) {
              const i = documentos.findIndex((d) => d.id === r.cargado!.id);
              if (i >= 0) documentos[i] = r.cargado;
              else documentos.push(r.cargado);
            }
            return { block, result: r.salida, ms: Date.now() - t0 };
          }
          if (block.name === "redactar_documento") {
            // Guarda el borrador y avisa al cliente (chip con descarga) sin esperar al final del turno.
            const r = await ejecutarRedactar(block.input as Record<string, unknown>, { userId, conversacionId: convId });
            if (r.documento) emitir({ type: "documento", documento: r.documento });
            if (r.cargado) {
              const i = documentos.findIndex((d) => d.id === r.cargado!.id);
              if (i >= 0) documentos[i] = r.cargado;
              else documentos.push(r.cargado);
            }
            return { block, result: r.salida, ms: Date.now() - t0 };
          }
          const result = await ejecutarHerramientaAbogado(block.name, block.input as Record<string, unknown>, { userId, documentos });
          return { block, result, ms: Date.now() - t0 };
        })
      );
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const { block, result, ms } of salidas) {
        const resumen = resumenDeResultado(block.name, result);
        traza.tools.push({ name: block.name, ms, resumen });
        emitir({ type: "tool_done", tool: block.name, ms, resumen });
        fuentesTurno.push(...fuentesDesdeToolResult(block.name, result));
        if (block.name === "search_fiscal_knowledge" || block.name === "search_jurisprudencia") {
          try {
            const r = JSON.parse(result) as { resultados?: { cita: string; similitud: number; fuente?: string }[] };
            for (const h of r.resultados ?? []) traza.fundamentos.push({ cita: h.cita, similitud: h.similitud, fuente: h.fuente });
          } catch {
            /* best-effort */
          }
        }
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }
      currentMessages = [...currentMessages, { role: "assistant", content: toolUseBlocks }, { role: "user", content: toolResults }];
      toolRounds++;
      traza.rondas = toolRounds;
      rondasAgotadas = toolRounds >= maxRondas;
      // Ronda cerrada: desde aquí puede seguir otro proceso.
      await guardarCheckpoint(currentMessages, toolRounds);
    }
    if (rondasAgotadas) {
      // Se acabaron las rondas con herramientas pendientes: sin esto la
      // respuesta se quedaba en «voy a fundamentar…» y nada más. Una vuelta
      // final sin herramientas, con lo ya recuperado.
      const ultimo = currentMessages[currentMessages.length - 1];
      const contenido = Array.isArray(ultimo.content) ? ultimo.content : [{ type: "text" as const, text: String(ultimo.content) }];
      const cierre: Anthropic.MessageParam[] = [
        ...currentMessages.slice(0, -1),
        { role: "user", content: [...contenido, { type: "text", text: "No hay más consultas disponibles en este turno. Redacta ahora la respuesta completa con lo que ya recuperaste y di explícitamente qué puntos no pudiste verificar en la base." }] },
      ];
      const final = await anthropic.messages.create({ model, max_tokens: MAX_TOKENS_SALIDA, system, tools, tool_choice: { type: "none" }, messages: marcarCacheDeConversacion(cierre), stream: true });
      let fin = 0;
      let fout = 0;
      let fcw = 0;
      let fcr = 0;
      for await (const event of final) {
        if (event.type === "message_start") {
          fin = event.message.usage?.input_tokens ?? 0;
          fcw = event.message.usage?.cache_creation_input_tokens ?? 0;
          fcr = event.message.usage?.cache_read_input_tokens ?? 0;
        } else if (event.type === "message_delta") {
          fout = event.usage?.output_tokens ?? fout;
        } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          assistantText += event.delta.text;
          emitir({ type: "text", text: event.delta.text });
        }
      }
      traza.cacheReadTokens += fcr;
      await recordLlmCost(model, { input_tokens: fin, output_tokens: fout, cache_creation_input_tokens: fcw, cache_read_input_tokens: fcr }, { companyId: null, userId, subtipo: "ai.juridico" });
    }
    traza.modelo = model;
    traza.rondas = toolRounds;

    // Verificación de citas: siempre, salvo que se apague explícitamente.
    if (process.env.AI_VERIFICACION_JURIDICO !== "0" && assistantText.trim()) {
      const v = await verificarRespuesta(anthropic, {
        pregunta: args.pregunta,
        respuesta: assistantText,
        fuentes: fuentesTurno,
        cost: { companyId: null, userId, subtipo: "ai.juridico.verificacion" },
        indiceOrdenamientos: indiceOrdenamientos(),
      });
      traza.verificacion = { verificada: v.verificada, corregida: v.corregida, problemas: v.problemas.length, citasNoVerificables: v.citasNoVerificables, ms: v.ms };
      if (v.corregida) {
        assistantText = v.texto;
        emitir({ type: "replace", text: assistantText });
      }
      // Sobre el texto ENTREGADO, para que los offsets sirvan tal cual.
      traza.citas = construirCitas({ texto: assistantText, fuentes: fuentesTurno, indiceOrdenamientos: indiceOrdenamientos(), resueltas: v.resueltas, problemas: v.problemas, citasNoVerificables: v.citasNoVerificables, verificada: v.verificada, corregida: v.corregida });
    } else if (assistantText.trim()) {
      // Sin pase de verificación se marcan igual, con estado «sin_verificar».
      traza.citas = construirCitas({ texto: assistantText, fuentes: fuentesTurno, indiceOrdenamientos: indiceOrdenamientos(), verificada: false, corregida: false });
    }

    let assistantMessageId: string | null = null;
    try {
      assistantMessageId = await persistirAsistente();
    } catch (e) {
      reportError(e, { ruta: "juridico/chat", paso: "persistir-asistente", conversacionId: convId });
    }
    emitir({ type: "done", messageId: assistantMessageId, traza });
  } catch (error) {
    // Se reporta (antes se tragaba) y se guarda lo que alcanzó a escribir.
    reportError(error, { ruta: "juridico/chat", conversacionId: convId, userId, rondas: traza.rondas, chars: assistantText.length });
    const mensaje = mensajeDeErrorParaAbogado(error);
    try {
      await persistirAsistente({ error: mensaje, cortado: true });
    } catch {
      /* ya se reportó el error principal */
    }
    emitir({ type: "error", error: mensaje });
    throw error;
  }
}
