import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { tools } from "@/lib/ai/tools";
import { executeToolCall } from "@/lib/ai/tool-executor";
import { buildSystemBlocks } from "@/lib/ai/system-prompt";
import { bloqueCierre } from "@/lib/cierre/contexto";
import { evaluarCierre } from "@/lib/cierre/evaluar";
import { empresaTieneCierreGuiado } from "@/lib/cierre/gate";
import { esClavePaso } from "@/lib/cierre/claves";
import { etiquetaPeriodo } from "@/lib/cierre/plantillas";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { gateEscritura } from "@/lib/subscription";
import { recordLlmCost } from "@/lib/costos/record";
import { asegurarUsoIA, respuestaTopeIA } from "@/lib/ai/guardia";
import { checkChatUserDaily } from "@/lib/ai/rate-limit";
import { effectiveWhatsappPlan } from "@/lib/planes";
import { getChatPendingAction } from "@/lib/ai/pending-action";
import { MAX_BODY_BYTES, sanearHistorial } from "@/lib/ai/historial";
import { fuentesDesdeToolResult, verificarRespuesta, type FuenteVerificacion } from "@/lib/ai/verificacion";

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env

// Streaming, long-running turn (multiple tool rounds: DB + embeddings + model).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_TOOL_ROUNDS = 5;
// Assistant brain: best available model, overridable per deployment. If the API
// key's tier doesn't have the primary yet, fall back once instead of breaking
// the chat.
const CHAT_MODEL = process.env.AI_CHAT_MODEL ?? "claude-fable-5";
const CHAT_MODEL_FALLBACK = "claude-opus-4-8";
// Heartbeat keeps the SSE connection alive during the silent gaps while tools
// execute (tax position, KB embedding/vector search) and the next model call
// reaches its first token — otherwise mobile carriers/proxies drop the idle
// stream and the client surfaces "Load failed".
const HEARTBEAT_MS = 10_000;

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "La conversación es demasiado larga. Inicia una conversación nueva." }, { status: 413 });
  }
  let body: {
    messages?: unknown;
    companyId?: string;
    conversationId?: string;
    contexto?: { ruta?: unknown; cierre?: { year?: unknown; month?: unknown; paso?: unknown } };
  };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }
  const { companyId, conversationId, contexto } = body;
  // Ruta que el usuario tiene abierta (sólo rutas internas, acotada): va al
  // system prompt para que «esto» / «aquí» signifiquen algo.
  const rutaActual =
    typeof contexto?.ruta === "string" && contexto.ruta.startsWith("/") && contexto.ruta.length <= 200
      ? contexto.ruta
      : undefined;

  // Cierre guiado: si el usuario está en /cierre, el periodo y el paso viajan
  // en el contexto. Con ellos el copiloto recibe el estado de los doce pasos y
  // las CIFRAS ya calculadas del paso activo — sin esto contestaba de memoria y
  // llegó a pedir datos que el sistema ya tenía.
  const cierreCtx =
    typeof contexto?.cierre?.year === "number" &&
    typeof contexto.cierre.month === "number" &&
    contexto.cierre.month >= 1 &&
    contexto.cierre.month <= 12
      ? {
          year: contexto.cierre.year,
          month: contexto.cierre.month,
          paso: esClavePaso(contexto.cierre.paso) ? contexto.cierre.paso : undefined,
        }
      : undefined;

  const messages = sanearHistorial(body.messages);
  if (!companyId || !messages || messages.length === 0) {
    return NextResponse.json({ error: "companyId y messages (texto) son requeridos" }, { status: 400 });
  }

  // Verify company membership
  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) {
    return NextResponse.json({ error: "Sin acceso a esta empresa" }, { status: 403 });
  }

  // Todo lo que sigue a la membresía va EN PARALELO: eran cuatro viajes a la
  // base en serie (suscripción, empresa, techo de IA) más la evaluación del
  // cierre, y el usuario no veía la primera letra hasta que terminaban.
  // La empresa se pide UNA vez (antes se consultaba dos: plan y datos).
  const [gate, empresa, guardia, cierreEvaluado] = await Promise.all([
    // Gating de suscripción (bandera SUBSCRIPTION_ENFORCEMENT_ENABLED): con la
    // prueba vencida el chat responde 402 con mensaje en español para la UI.
    gateEscritura(session.user.id),
    prisma.company.findUnique({
      where: { id: companyId },
      select: { rfc: true, razonSocial: true, regimenFiscal: true, codigoPostal: true, tier: true, despachoId: true },
    }),
    // Guardia de IA: techo mensual de la empresa (todas las funciones, + extra
    // comprado) y tope diario de operaciones del usuario. Se re-evalúa en cada
    // ronda de herramientas más abajo, para que un turno no se pase del techo.
    asegurarUsoIA({ userId: session.user.id, companyId }),
    // Cierre guiado: si el usuario está en /cierre, el periodo y el paso viajan
    // en el contexto. Con ellos el copiloto recibe el estado de los doce pasos
    // y las CIFRAS ya calculadas del paso activo. La evaluación se memoiza por
    // proceso (ver evaluar.ts): la pantalla acaba de pedirla, así que casi
    // siempre es un acierto y no cuesta nada.
    cierreCtx
      ? (async () => {
          if (!(await empresaTieneCierreGuiado(companyId))) return null;
          return evaluarCierre(companyId, cierreCtx.year, cierreCtx.month);
        })().catch((e) => {
          console.error("[ai/chat] contexto del cierre falló:", e instanceof Error ? e.message : e);
          return null;
        })
      : Promise.resolve(null),
  ]);
  if (gate) return gate;
  if (!empresa) {
    return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });
  }
  if (!guardia.ok) return respuestaTopeIA(guardia);

  // Backstop por USUARIO: el techo anterior protege el COGS de la empresa, pero
  // no impide que una sola persona monopolice el presupuesto compartido. Este
  // tope diario acota los mensajes de un mismo usuario al día. Una empresa de
  // despacho hereda el tope del plan DESPACHO.
  const userDaily = await checkChatUserDaily({
    userId: session.user.id,
    companyId,
    plan: effectiveWhatsappPlan({ tier: empresa.tier, despachoId: empresa.despachoId }),
  });
  if (!userDaily.allowed) {
    return NextResponse.json({ error: userDaily.mensaje }, { status: 429 });
  }

  // Sólo roles con permiso de escritura pueden STAGEAR acciones reversibles. A un
  // VIEWER ni siquiera le exponemos las herramientas "proponer_*".
  const canWrite = member.role !== "VIEWER";
  const availableTools = canWrite ? tools : tools.filter((t) => !t.name.startsWith("proponer_"));

  // El bloque del cierre para el prompt. El paso dice QUÉ REVISAR, no qué puede
  // ver: el copiloto conserva TODAS sus herramientas dentro del cierre.
  // Acotarlas por paso lo dejaba ciego (en «punto de partida» no podía mirar
  // facturas ni bancos) y encima invalidaba la caché del prompt en cada cambio
  // de paso, porque las tools van en el prefijo cacheado.
  const bloqueDelCierre =
    cierreEvaluado && cierreCtx
      ? bloqueCierre(
          cierreEvaluado,
          cierreCtx.paso ? (cierreEvaluado.pasos.find((p) => p.clave === cierreCtx.paso) ?? null) : null,
          etiquetaPeriodo(cierreCtx.year, cierreCtx.month)
        )
      : undefined;

  // ── Persistencia de la conversación ─────────────────────────────────────────
  // El último mensaje del cliente es el nuevo turno del usuario. Resolvemos (o
  // creamos) la conversación antes de transmitir; al cerrar el turno guardamos el
  // mensaje del usuario + la respuesta del asistente.
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const nuevoMensajeUsuario = typeof lastUser?.content === "string" ? lastUser.content : "";
  const userId = session.user.id;

  let convId = conversationId;
  let convCreada = false;
  if (convId) {
    const conv = await prisma.chatConversation.findUnique({
      where: { id: convId },
      select: { userId: true, companyId: true, visibility: true },
    });
    if (!conv) return NextResponse.json({ error: "Conversación no encontrada" }, { status: 404 });
    const acceso = conv.userId === userId || (conv.visibility === "COMPANY" && conv.companyId === companyId);
    if (!acceso) return NextResponse.json({ error: "Sin acceso a esta conversación" }, { status: 403 });
  } else {
    const title = nuevoMensajeUsuario.trim().slice(0, 60) || "Nueva conversación";
    const created = await prisma.chatConversation.create({
      data: { companyId, userId, title },
      select: { id: true },
    });
    convId = created.id;
    convCreada = true;
  }

  // System prompt en bloques: el estable lleva cache_control (junto con `tools`
  // es casi toda la entrada del turno) y el de navegación va después.
  const systemBlocks = buildSystemBlocks(empresa, { ruta: rutaActual, bloqueCierre: bloqueDelCierre });

  // Stream response with tool-use loop
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Enqueue that no-ops if the stream is already closed (e.g. client gone).
      const safeEnqueue = (chunk: Uint8Array) => {
        try {
          controller.enqueue(chunk);
        } catch {
          /* stream closed */
        }
      };
      const heartbeat = setInterval(() => {
        safeEnqueue(encoder.encode(": ping\n\n")); // SSE comment; clients ignore it
      }, HEARTBEAT_MS);

      // Avísale al cliente qué conversación es (sobre todo si la acabamos de crear)
      // para que la fije y la muestre en el historial.
      safeEnqueue(
        encoder.encode(`data: ${JSON.stringify({ type: "conversation", id: convId, nueva: convCreada })}\n\n`)
      );

      // Acumula la respuesta del asistente para persistirla al final.
      let assistantText = "";
      // Traza del turno: sin ella un fallo del copiloto no se puede depurar (¿no
      // ENCONTRÓ el artículo o lo IGNORÓ?). Se guarda en ChatMessage.meta.
      const traza: {
        modelo: string;
        rondas: number;
        tools: { name: string; ms: number }[];
        fundamentos: { cita: string; similitud: number }[];
        cacheReadTokens: number;
        verificacion?: { verificada: boolean; corregida: boolean; problemas: number; citasNoVerificables: string[]; ms: number };
      } = { modelo: CHAT_MODEL, rondas: 0, tools: [], fundamentos: [], cacheReadTokens: 0 };
      // Textos que la KB devolvió en el turno: son las fuentes contra las que
      // se verifica la respuesta (Fase 3).
      const fuentesTurno: FuenteVerificacion[] = [];

      try {
        let currentMessages = [...messages];
        let toolRounds = 0;
        let model = CHAT_MODEL;

        while (toolRounds < MAX_TOOL_ROUNDS) {
          // A partir de la segunda ronda, re-evaluar el techo: el gasto de las
          // rondas anteriores ya está registrado. Si se alcanzó, cerramos el
          // turno con un aviso en vez de seguir gastando.
          if (toolRounds > 0) {
            const g = await asegurarUsoIA({ userId, companyId });
            if (!g.ok) {
              const aviso = `\n\n_${g.mensaje}_`;
              assistantText += aviso;
              safeEnqueue(encoder.encode(`data: ${JSON.stringify({ type: "text", text: aviso })}\n\n`));
              break;
            }
          }

          const params: Anthropic.MessageCreateParamsStreaming = {
            model,
            max_tokens: 4096,
            system: systemBlocks,
            tools: availableTools,
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
          // Métrica de costo: tokens de esta ronda (streaming → vienen en eventos),
          // incluidos los de caché (message_start trae el usage de entrada).
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
                currentToolUse = {
                  id: event.content_block.id,
                  name: event.content_block.name,
                  input: "",
                };
                // Send a thinking indicator to the client
                safeEnqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "tool_start", tool: event.content_block.name })}\n\n`
                  )
                );
              }
            } else if (event.type === "content_block_delta") {
              if (event.delta.type === "text_delta") {
                assistantText += event.delta.text;
                safeEnqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "text", text: event.delta.text })}\n\n`
                  )
                );
              } else if (event.delta.type === "input_json_delta" && currentToolUse) {
                currentToolUse.input += event.delta.partial_json;
              }
            } else if (event.type === "content_block_stop") {
              if (currentToolUse) {
                let parsedInput: unknown = {};
                try {
                  parsedInput = JSON.parse(currentToolUse.input || "{}");
                } catch {
                  parsedInput = {}; // malformed partial JSON → run with empty input
                }
                toolUseBlocks.push({
                  type: "tool_use",
                  id: currentToolUse.id,
                  name: currentToolUse.name,
                  input: parsedInput,
                });
                currentToolUse = null;
              }
            }
          }

          traza.cacheReadTokens += roundCacheRead;
          // Costo de la ronda. Se ESPERA (no fire-and-forget): la guardia de la
          // siguiente ronda debe ver este gasto, y el insert es una fila.
          await recordLlmCost(
            model,
            {
              input_tokens: roundInput,
              output_tokens: roundOutput,
              cache_creation_input_tokens: roundCacheWrite,
              cache_read_input_tokens: roundCacheRead,
            },
            // El cierre guiado se mide aparte: es una feature de plan y su
            // gasto tiene que poder separarse del chat general.
            { companyId, userId, subtipo: cierreCtx ? "ai.cierre" : "ai.chat" },
          );

          if (!hasToolUse) break;

          // Las herramientas de LECTURA de una misma ronda corren en paralelo:
          // cuando el copiloto pide declaraciones + posición + checklist, en
          // serie eran tres esperas encadenadas antes de volver al modelo. Las
          // "proponer_*" siguen en serie y en orden: stagean sobre la misma
          // conversación y la última propuesta es la que queda.
          const llamadas = toolUseBlocks.filter((b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use");
          const correr = async (block: Anthropic.ToolUseBlockParam) => {
            const t0 = Date.now();
            const result = await executeToolCall(
              block.name,
              block.input as Record<string, unknown>,
              companyId,
              // inApp habilita las herramientas "proponer_*" (tarjeta Confirmar).
              // Sólo roles con permiso de escritura pueden STAGEAR (VIEWER no);
              // el confirm endpoint re-valida igualmente. userId habilita las
              // herramientas de cartera (query_despacho_panorama), acotadas a
              // las empresas accesibles del propio usuario.
              { conversationId: convId!, inApp: canWrite, userId, cierre: cierreCtx }
            );
            return { block, result, ms: Date.now() - t0 };
          };
          const salidas = new Map<string, { result: string; ms: number }>();
          const lecturas = llamadas.filter((b) => !b.name.startsWith("proponer_"));
          for (const r of await Promise.all(lecturas.map(correr))) {
            salidas.set(r.block.id, { result: r.result, ms: r.ms });
          }
          for (const block of llamadas.filter((b) => b.name.startsWith("proponer_"))) {
            const r = await correr(block);
            salidas.set(block.id, { result: r.result, ms: r.ms });
          }

          // El orden que ve el modelo es el orden en que pidió las herramientas.
          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const block of llamadas) {
            const salida = salidas.get(block.id);
            if (!salida) continue;
            traza.tools.push({ name: block.name, ms: salida.ms });
            fuentesTurno.push(...fuentesDesdeToolResult(block.name, salida.result));
            if (block.name === "search_fiscal_knowledge") {
              try {
                const r = JSON.parse(salida.result) as { resultados?: { cita: string; similitud: number }[] };
                for (const h of r.resultados ?? []) traza.fundamentos.push({ cita: h.cita, similitud: h.similitud });
              } catch {
                /* la traza es best-effort */
              }
            }
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: salida.result });
          }

          // Append assistant message with tool use + user message with tool results
          currentMessages = [
            ...currentMessages,
            { role: "assistant", content: toolUseBlocks },
            { role: "user", content: toolResults },
          ];

          toolRounds++;
        }
        traza.modelo = model;
        traza.rondas = toolRounds;

        // Pase de verificación (Fase 3): sólo cuando la respuesta cita algo.
        // Si encuentra afirmaciones que los artículos no sostienen, manda la
        // versión corregida con `replace` y esa es la que se persiste.
        // Opt-in (AI_VERIFICACION=1) hasta que el eval diga que mejora: la
        // primera medición (run 25) lo dejó peor que sin él.
        if (process.env.AI_VERIFICACION === "1" && assistantText.trim()) {
          const v = await verificarRespuesta(anthropic, {
            pregunta: nuevoMensajeUsuario,
            respuesta: assistantText,
            fuentes: fuentesTurno,
            cost: { companyId, userId },
          });
          traza.verificacion = {
            verificada: v.verificada,
            corregida: v.corregida,
            problemas: v.problemas.length,
            citasNoVerificables: v.citasNoVerificables,
            ms: v.ms,
          };
          if (v.corregida) {
            assistantText = v.texto;
            safeEnqueue(encoder.encode(`data: ${JSON.stringify({ type: "replace", text: assistantText })}\n\n`));
          }
        }

        // Si el asistente STAGEÓ una acción reversible en este turno, avísale al
        // cliente para que pinte la tarjeta Confirmar / Cancelar (el tap ejecuta).
        try {
          const pa = await getChatPendingAction(convId!);
          if (pa) {
            safeEnqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "pending_action",
                  action: { type: pa.type, summary: pa.summary, token: pa.token, expiresAt: pa.expiresAt },
                })}\n\n`,
              ),
            );
          }
        } catch {
          /* no rompemos el turno por no poder pintar la tarjeta */
        }

        // Persistir el turno (mensaje del usuario + respuesta del asistente) y
        // subir la conversación al tope del historial. Best-effort: si falla, no
        // rompemos la respuesta que el usuario ya recibió.
        // El id del mensaje del asistente viaja en `done` para que el cliente
        // pueda colgarle el feedback (pulgar / corrección).
        let assistantMessageId: string | null = null;
        try {
          await prisma.chatMessage.create({
            data: { conversationId: convId!, role: "user", content: nuevoMensajeUsuario, authorId: userId },
          });
          if (assistantText.trim()) {
            const creado = await prisma.chatMessage.create({
              data: { conversationId: convId!, role: "assistant", content: assistantText, authorId: null, meta: traza },
              select: { id: true },
            });
            assistantMessageId = creado.id;
          }
          await prisma.chatConversation.update({ where: { id: convId! }, data: { updatedAt: new Date() } });
        } catch (e) {
          console.error("[ai/chat] persistencia falló:", e);
        }

        safeEnqueue(encoder.encode(`data: ${JSON.stringify({ type: "done", messageId: assistantMessageId })}\n\n`));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Error interno";
        safeEnqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "error", error: message })}\n\n`)
        );
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
