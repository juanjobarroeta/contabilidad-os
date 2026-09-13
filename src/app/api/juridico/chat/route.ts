import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { AuthzError, puedeUsarJuridico, requireUser } from "@/lib/authz";
import { toolsAbogado } from "@/lib/ai/tools-abogado";
import { ejecutarHerramientaAbogado } from "@/lib/ai/executor-abogado";
import { buildSystemPromptAbogado } from "@/lib/ai/system-prompt-abogado";
import { recordLlmCost } from "@/lib/costos/record";
import { MAX_BODY_BYTES, sanearHistorial } from "@/lib/ai/historial";
import { fuentesDesdeToolResult, verificarRespuesta, type FuenteVerificacion } from "@/lib/ai/verificacion";
import { bloqueDocumentosParaPrompt, toolsDocumentos, type DocumentoCargado, type Resumenes, type Seccion } from "@/lib/juridico/documentos";
import { ejecutarRedactar, toolRedactar } from "@/lib/juridico/redaccion";
import { iniciarTurno, respuestaSse, turnoEnCurso, turnoReciente, type EventoTurno } from "@/lib/juridico/turnos";
import { reportError } from "@/lib/observability";

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
//
// El turno corre como tarea del proceso (src/lib/juridico/turnos.ts) y la
// respuesta es una vista reanudable: si el teléfono suspende el fetch o
// Railway corta el stream, GET ?conversacionId=&desde=N reproduce lo que falta.
// El mensaje del usuario se guarda al arrancar; la respuesta al terminar (o lo
// que alcanzó a escribir, con meta.error, si el turno falla).
// Eventos SSE: turno | conversation | text | tool_start | tool_done | documento | replace | done | error
// ─────────────────────────────────────────────────────────────────────────────

const anthropic = new Anthropic();

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Revisar un contrato pide muchas consultas (varios artículos, jurisprudencia);
// si se agotan, hay una última vuelta SIN herramientas para que redacte.
const MAX_TOOL_ROUNDS = 10;
const MAX_TOOL_ROUNDS_CON_DOCUMENTOS = 24;
// Un escrito entero cabe en una sola llamada a redactar_documento: con 6 144
// tokens se cortaba a la mitad (y el turno moría con «user messages must have
// non-empty content»).
const MAX_TOKENS_SALIDA = 16_000;
const CHAT_MODEL = process.env.AI_CHAT_MODEL ?? "claude-fable-5";
const CHAT_MODEL_FALLBACK = "claude-opus-4-8";

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
  if (!(await puedeUsarJuridico(userId))) return NextResponse.json({ error: "Tu cuenta no tiene acceso al copiloto jurídico" }, { status: 403 });

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

  // Un turno a la vez por conversación.
  if (turnoEnCurso(convId)) return NextResponse.json({ error: "Ya hay una respuesta en curso en esta conversación; espera a que termine o vuelve a abrirla." }, { status: 409 });

  // Documentos de la conversación: bloque propio del system (cacheado aparte del
  // prompt base, que es igual para todas las conversaciones).
  const documentos: DocumentoCargado[] = (
    await prisma.juridicoDocumento.findMany({
      where: { conversacionId: convId },
      orderBy: { createdAt: "asc" },
      select: { id: true, nombre: true, paginas: true, caracteres: true, texto: true, secciones: true, resumenes: true },
    })
  ).map((d) => ({ ...d, secciones: (d.secciones as unknown as Seccion[] | null) ?? [], resumenes: (d.resumenes as unknown as Resumenes | null) ?? null }));
  // Un expediente se lee por secciones: hacen falta más rondas de herramientas.
  const maxRondas = documentos.length > 0 ? MAX_TOOL_ROUNDS_CON_DOCUMENTOS : MAX_TOOL_ROUNDS;
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: buildSystemPromptAbogado(), cache_control: { type: "ephemeral" } },
    ...(documentos.length > 0 ? [{ type: "text" as const, text: bloqueDocumentosParaPrompt(documentos), cache_control: { type: "ephemeral" as const } }] : []),
  ];
  // Redactar siempre está; leer/buscar sólo cuando hay documentos.
  const tools = [...toolsAbogado, toolRedactar, ...(documentos.length > 0 ? toolsDocumentos : [])];

  // El mensaje del usuario se guarda YA: si el turno muere, la conversación lo conserva.
  let mensajeUsuarioId: string | null = null;
  try {
    const mu = await prisma.juridicoMensaje.create({ data: { conversacionId: convId, rol: "user", contenido: nuevoMensajeUsuario }, select: { id: true } });
    mensajeUsuarioId = mu.id;
  } catch (e) {
    reportError(e, { ruta: "juridico/chat", paso: "persistir-usuario", conversacionId: convId });
  }

  const turno = iniciarTurno({
    conversacionId: convId,
    userId,
    correr: async (emitir: (e: EventoTurno) => void) => {
      emitir({ type: "conversation", id: convId, nueva: convCreada });
      let assistantText = "";
      const traza: Traza = { modelo: CHAT_MODEL, rondas: 0, tools: [], fundamentos: [], cacheReadTokens: 0, ...(documentos.length > 0 ? { documentos: documentos.map((d) => d.nombre) } : {}) };
      const fuentesTurno: FuenteVerificacion[] = [];
      const persistirAsistente = async (extra?: Record<string, unknown>) => {
        if (!assistantText.trim() && !extra) return null;
        const creado = await prisma.juridicoMensaje.create({
          data: { conversacionId: convId!, rol: "assistant", contenido: assistantText, meta: JSON.parse(JSON.stringify({ ...traza, ...extra })) },
          select: { id: true },
        });
        await prisma.juridicoConversacion.update({ where: { id: convId! }, data: { updatedAt: new Date() } });
        return creado.id;
      };
      try {
        let currentMessages = [...messages];
        let toolRounds = 0;
        let model = CHAT_MODEL;
        let rondasAgotadas = false;

        while (toolRounds < maxRondas) {
          const params: Anthropic.MessageCreateParamsStreaming = {
            model,
            max_tokens: MAX_TOKENS_SALIDA,
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
              if (block.name === "redactar_documento") {
                // Guarda el borrador y avisa al cliente (chip con descarga) sin esperar al final del turno.
                const r = await ejecutarRedactar(block.input as Record<string, unknown>, { userId, conversacionId: convId! });
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
          rondasAgotadas = toolRounds >= maxRondas;
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
          const final = await anthropic.messages.create({ model, max_tokens: MAX_TOKENS_SALIDA, system, tools, tool_choice: { type: "none" }, messages: cierre, stream: true });
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
          assistantMessageId = await persistirAsistente();
        } catch (e) {
          reportError(e, { ruta: "juridico/chat", paso: "persistir-asistente", conversacionId: convId! });
        }
        emitir({ type: "done", messageId: assistantMessageId, traza });
      } catch (error) {
        // Se reporta (antes se tragaba) y se guarda lo que alcanzó a escribir.
        reportError(error, { ruta: "juridico/chat", conversacionId: convId!, userId, rondas: traza.rondas, chars: assistantText.length });
        const mensaje = error instanceof Error ? error.message : "Error interno";
        try {
          await persistirAsistente({ error: mensaje, cortado: true });
        } catch {
          /* ya se reportó el error principal */
        }
        emitir({ type: "error", error: mensaje });
        throw error;
      }
    },
  });
  void mensajeUsuarioId;
  return respuestaSse(turno);
}

// GET /api/juridico/chat?conversacionId=&desde=N — reanudar un turno: reproduce
// los eventos desde N y sigue en vivo; 204 si no hay turno en memoria (el
// cliente entonces recarga la conversación: si el turno terminó, ahí están
// los mensajes).
export async function GET(req: Request) {
  let usuario: { id: string };
  try {
    usuario = await requireUser(req);
  } catch (e) {
    return NextResponse.json({ error: e instanceof AuthzError ? e.message : "Unauthorized" }, { status: e instanceof AuthzError ? e.status : 401 });
  }
  const url = new URL(req.url);
  const convId = url.searchParams.get("conversacionId") ?? "";
  const desde = Number(url.searchParams.get("desde") ?? "0") || 0;
  if (!convId) return NextResponse.json({ error: "conversacionId es requerido" }, { status: 400 });
  const turno = turnoReciente(convId);
  if (!turno || turno.userId !== usuario.id) return new Response(null, { status: 204 });
  return respuestaSse(turno, desde);

}
