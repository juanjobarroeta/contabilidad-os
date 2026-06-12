import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { tools } from "@/lib/ai/tools";
import { executeToolCall } from "@/lib/ai/tool-executor";
import { buildSystemPrompt } from "@/lib/ai/system-prompt";
import { getEffectiveCompanyMembership } from "@/lib/authz";

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env

// Streaming, long-running turn (multiple tool rounds: DB + embeddings + model).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_TOOL_ROUNDS = 5;
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

  const body = await req.json();
  const { messages, companyId } = body as {
    messages: Anthropic.MessageParam[];
    companyId: string;
  };

  if (!companyId || !messages?.length) {
    return NextResponse.json({ error: "companyId y messages son requeridos" }, { status: 400 });
  }

  // Verify company membership
  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) {
    return NextResponse.json({ error: "Sin acceso a esta empresa" }, { status: 403 });
  }

  // Fetch company context for system prompt
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true, razonSocial: true, regimenFiscal: true, codigoPostal: true },
  });
  if (!company) {
    return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });
  }

  const systemPrompt = buildSystemPrompt(company);

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

      try {
        let currentMessages = [...messages];
        let toolRounds = 0;

        while (toolRounds < MAX_TOOL_ROUNDS) {
          const response = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 4096,
            system: systemPrompt,
            tools,
            messages: currentMessages,
            stream: true,
          });

          let hasToolUse = false;
          const toolUseBlocks: Anthropic.ContentBlockParam[] = [];
          let currentToolUse: { id: string; name: string; input: string } | null = null;

          for await (const event of response) {
            if (event.type === "content_block_start") {
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

          if (!hasToolUse) break;

          // Execute all tool calls and build tool results
          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const block of toolUseBlocks) {
            if (block.type === "tool_use") {
              const result = await executeToolCall(
                block.name,
                block.input as Record<string, unknown>,
                companyId
              );
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: result,
              });
            }
          }

          // Append assistant message with tool use + user message with tool results
          currentMessages = [
            ...currentMessages,
            { role: "assistant", content: toolUseBlocks },
            { role: "user", content: toolResults },
          ];

          toolRounds++;
        }

        safeEnqueue(encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`));
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
