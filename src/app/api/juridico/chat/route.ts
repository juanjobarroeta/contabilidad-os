import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { AuthzError, isOperador, requireUser } from "@/lib/authz";
import { toolsAbogado } from "@/lib/ai/tools-abogado";
import { ejecutarHerramientaAbogado } from "@/lib/ai/executor-abogado";
import { buildSystemPromptAbogado } from "@/lib/ai/system-prompt-abogado";
import { recordLlmCost } from "@/lib/costos/record";
import { MAX_BODY_BYTES, sanearHistorial } from "@/lib/ai/historial";
import { fuentesDesdeToolResult, verificarRespuesta, type FuenteVerificacion } from "@/lib/ai/verificacion";
import { bloqueDocumentosParaPrompt, toolsDocumentos, type DocumentoCargado, type Seccion } from "@/lib/juridico/documentos";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/juridico/chat — el copiloto JURÍDICO (perfil abogado), en streaming.
//
// Superficie de prueba del operador (docs/MOTOR-JURIDICO.md §6): mismo motor
// que el copiloto contable (tool-use en rondas, SSE, traza persistida) pero sin
// empresa, con todo el corpus y la jurisprudencia, y con el pase de
// verificación de citas SIEMPRE encendido — aquí el costo lo paga la prueba.
// Sólo el operador: sin guardia de IA por empresa; cada llamada queda en
// CostEvent (subtipo ai.juridico) a nombre del usuario.
//
// Body: { messages: [{role, content}], conversacionId?: string }
// Los documentos adjuntos a la conversación (POST /api/juridico/documentos) se
// cargan aquí: su índice va en un bloque del system prompt (y el texto entero
// si cabe) y el agente los recorre con leer_documento / buscar_en_documento.
// Eventos SSE: conversation | text | tool_start | tool_done | replace | done | error
// ─────────────────────────────────────────────────────────────────────────────

const anthropic = new Anthropic();

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_TOOL_ROUNDS = 6;
const CHAT_MODEL = process.env.AI_CHAT_MODEL ?? "claude-fable-5";
const CHAT_MODEL_FALLBACK = "claude-opus-4-8";
const HEARTBEAT_MS = 10_000;

interface Traza {
  modelo: string;
  rondas: number;
  tools: { name: string; ms: number; resumen?: string }[];
  fundamentos: { cita: string; similitud: number; fuente?: string }[];
  documentos?: string[];
  verificacion?: { verificada: boolean; corregida: boolean; problemas: number; citasNoVerificables: string[]; ms: number };
  cacheReadTokens: number;
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

export async function POST(req: Request) {
  let usuario: { id: string };
  try {
    usuario = await requireUser(req);
  } catch (e) {
    return NextResponse.json({ error: e instanceof AuthzError ? e.message : "Unauthorized" }, { status: e instanceof AuthzError ? e.status : 401 });
  }
  const userId = usuario.id;
  if (!(await isOperador(userId))) return NextResponse.json({ error: "Sólo el operador puede usar el copiloto jurídico por ahora" }, { status: 403 });

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "La conversación es demasiado larga. Inicia una conversación nueva." }, { status: 413 });
  }
  let body: { messages?: unknown; conversacionId?: unknown };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }
  const messages = sanearHistorial(body.messages);
  if (!messages || messages.length === 0) return NextResponse.json({ error: "messages (texto) es requerido" }, { status: 400 });

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const nuevoMensajeUsuario = typeof lastUser?.content === "string" ? lastUser.content : "";

  // Conversación: la dada (del usuario) o una nueva titulada con el primer mensaje.
  let convId = typeof body.conversacionId === "string" ? body.conversacionId : null;
  let convCreada = false;
  if (convId) {
    const conv = await prisma.juridicoConversacion.findUnique({ where: { id: convId }, select: { userId: true, archivedAt: true } });
    if (!conv || conv.userId !== userId || conv.archivedAt) return NextResponse.json({ error: "Conversación no encontrada" }, { status: 404 });
  } else {
    const created = await prisma.juridicoConversacion.create({
      data: { userId, titulo: nuevoMensajeUsuario.trim().slice(0, 80) || "Nueva conversación" },
      select: { id: true },
    });
    convId = created.id;
    convCreada = true;
  }

  // Documentos de la conversación: bloque propio del system (cacheado aparte del
  // prompt base, que es igual para todas las conversaciones).
  const documentos: DocumentoCargado[] = (
    await prisma.juridicoDocumento.findMany({
      where: { conversacionId: convId },
      orderBy: { createdAt: "asc" },
      select: { id: true, nombre: true, paginas: true, caracteres: true, texto: true, secciones: true },
    })
  ).map((d) => ({ ...d, secciones: (d.secciones as unknown as Seccion[] | null) ?? [] }));
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: buildSystemPromptAbogado(), cache_control: { type: "ephemeral" } },
    ...(documentos.length > 0 ? [{ type: "text" as const, text: bloqueDocumentosParaPrompt(documentos), cache_control: { type: "ephemeral" as const } }] : []),
  ];
  const tools = documentos.length > 0 ? [...toolsAbogado, ...toolsDocumentos] : toolsAbogado;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const safeEnqueue = (chunk: Uint8Array) => {
        try {
          controller.enqueue(chunk);
        } catch {
          /* cerrado */
        }
      };
      const emitir = (evento: Record<string, unknown>) => safeEnqueue(encoder.encode(`data: ${JSON.stringify(evento)}\n\n`));
      const heartbeat = setInterval(() => safeEnqueue(encoder.encode(": ping\n\n")), HEARTBEAT_MS);
      emitir({ type: "conversation", id: convId, nueva: convCreada });

      let assistantText = "";
      const traza: Traza = { modelo: CHAT_MODEL, rondas: 0, tools: [], fundamentos: [], cacheReadTokens: 0, ...(documentos.length > 0 ? { documentos: documentos.map((d) => d.nombre) } : {}) };
      const fuentesTurno: FuenteVerificacion[] = [];

      try {
        let currentMessages = [...messages];
        let toolRounds = 0;
        let model = CHAT_MODEL;

        while (toolRounds < MAX_TOOL_ROUNDS) {
          const params: Anthropic.MessageCreateParamsStreaming = {
            model,
            max_tokens: 6144,
            system,
            tools,
            messages: currentMessages,
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

          for await (const event of response) {
            if (event.type === "message_start") {
              roundInput = event.message.usage?.input_tokens ?? 0;
              roundCacheWrite = event.message.usage?.cache_creation_input_tokens ?? 0;
              roundCacheRead = event.message.usage?.cache_read_input_tokens ?? 0;
            } else if (event.type === "message_delta") {
              roundOutput = event.usage?.output_tokens ?? roundOutput;
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
                parsedInput = {};
              }
              toolUseBlocks.push({ type: "tool_use", id: currentToolUse.id, name: currentToolUse.name, input: parsedInput });
              currentToolUse = null;
            }
          }

          traza.cacheReadTokens += roundCacheRead;
          await recordLlmCost(
            model,
            { input_tokens: roundInput, output_tokens: roundOutput, cache_creation_input_tokens: roundCacheWrite, cache_read_input_tokens: roundCacheRead },
            { companyId: null, userId, subtipo: "ai.juridico" }
          );

          if (!hasToolUse) break;

          const llamadas = toolUseBlocks.filter((b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use");
          const salidas = await Promise.all(
            llamadas.map(async (block) => {
              const t0 = Date.now();
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
        }
        traza.modelo = model;
        traza.rondas = toolRounds;

        // Verificación de citas: siempre, salvo que se apague explícitamente.
        if (process.env.AI_VERIFICACION_JURIDICO !== "0" && assistantText.trim()) {
          const v = await verificarRespuesta(anthropic, {
            pregunta: nuevoMensajeUsuario,
            respuesta: assistantText,
            fuentes: fuentesTurno,
            cost: { companyId: null, userId, subtipo: "ai.juridico.verificacion" },
          });
          traza.verificacion = { verificada: v.verificada, corregida: v.corregida, problemas: v.problemas.length, citasNoVerificables: v.citasNoVerificables, ms: v.ms };
          if (v.corregida) {
            assistantText = v.texto;
            emitir({ type: "replace", text: assistantText });
          }
        }

        let assistantMessageId: string | null = null;
        try {
          await prisma.juridicoMensaje.create({ data: { conversacionId: convId!, rol: "user", contenido: nuevoMensajeUsuario } });
          if (assistantText.trim()) {
            const creado = await prisma.juridicoMensaje.create({
              data: { conversacionId: convId!, rol: "assistant", contenido: assistantText, meta: JSON.parse(JSON.stringify(traza)) },
              select: { id: true },
            });
            assistantMessageId = creado.id;
          }
          await prisma.juridicoConversacion.update({ where: { id: convId! }, data: { updatedAt: new Date() } });
        } catch (e) {
          console.error("[juridico/chat] persistencia falló:", e);
        }
        emitir({ type: "done", messageId: assistantMessageId, traza });
      } catch (error) {
        emitir({ type: "error", error: error instanceof Error ? error.message : "Error interno" });
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* ya cerrado */
        }
      }
    },
  });

  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
}
