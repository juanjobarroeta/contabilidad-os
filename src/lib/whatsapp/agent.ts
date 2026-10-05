import Anthropic from "@anthropic-ai/sdk";
import { tools } from "@/lib/ai/tools";
import { executeToolCall } from "@/lib/ai/tool-executor";
import { buildWhatsappSystemPrompt, type IdentidadCopiloto } from "./system-prompt";
import { prisma } from "@/lib/prisma";
import { bloqueExpediente } from "@/lib/expediente/cargar";
import { entidadesDeEmpresa } from "@/lib/fiscal-kb/entidades-empresa";
import { nombreDe, sanearPiel } from "@/lib/copiloto/personajes";
import { sanearProgreso } from "@/lib/onboarding/progreso";
import { meteredCreate } from "@/lib/costos/anthropic";

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env

// Same model as the web assistant (AI_CHAT_MODEL override; falls back once if
// the API key's tier doesn't have the primary). WhatsApp conversations are
// chattier, so we allow a couple more tool rounds — but cap hard to keep
// latency under Twilio's webhook timeout and to bound cost.
const MODEL = process.env.AI_CHAT_MODEL ?? "claude-fable-5";
const MODEL_FALLBACK = "claude-opus-4-8";
const MAX_TOOL_ROUNDS = 6;
const MAX_TOKENS = 1024; // replies are short on WhatsApp

export interface WhatsappCompany {
  rfc: string;
  razonSocial: string;
  regimenFiscal: string;
  codigoPostal: string;
}

/** Cartera del usuario para el encuadre "despacho" (varias empresas). */
export interface WhatsappCartera {
  total: number;
  empresas: string[];
}

/**
 * Runs the read-only agent loop for one inbound WhatsApp turn and returns the
 * final assistant text (non-streaming — the channel wants a single message).
 *
 * `history` is prior turns (oldest→newest, excluding the current user message),
 * already trimmed by the caller. `userText` is the new inbound message.
 *
 * Tools execute in-process via the shared executor, scoped to `companyId` — the
 * exact same read tools the web assistant uses, so access rules are identical.
 */
export async function runWhatsappAgent(opts: {
  companyId: string;
  company: WhatsappCompany;
  history: Anthropic.MessageParam[];
  userText: string;
  conversationId?: string;
  /** Usuario que consulta — habilita las herramientas de cartera (despacho). */
  userId?: string;
  /** Cartera del usuario, para el encuadre "despacho" en el prompt. */
  cartera?: WhatsappCartera;
}): Promise<string> {
  const { companyId, company, history, userText, conversationId, userId, cartera } = opts;

  // El mismo copiloto que en la app: su nombre y tono, los estados de la
  // empresa y el expediente (memoria compartida). Si algo falla, el turno sigue.
  const [identidad, expediente] = await Promise.all([
    identidadCopiloto(userId, companyId).catch(() => undefined),
    bloqueExpediente(companyId).catch(() => ""),
  ]);

  // Cache the system prompt + tool definitions across turns to cut cost/latency.
  // El expediente va DESPUÉS del breakpoint: cambia cuando se anota algo.
  const system: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: buildWhatsappSystemPrompt(company, cartera, identidad),
      cache_control: { type: "ephemeral" },
    },
    ...(expediente.trim() ? [{ type: "text" as const, text: expediente }] : []),
  ];

  let messages: Anthropic.MessageParam[] = [
    ...history,
    { role: "user", content: userText },
  ];

  let rounds = 0;
  let model = MODEL;
  while (rounds < MAX_TOOL_ROUNDS) {
    let response;
    try {
      response = await meteredCreate(anthropic, { companyId, userId: userId ?? null, subtipo: "whatsapp.agent" }, {
        model,
        max_tokens: MAX_TOKENS,
        system,
        tools,
        messages,
      });
    } catch (err) {
      if (model !== MODEL_FALLBACK && err instanceof Anthropic.NotFoundError) {
        model = MODEL_FALLBACK;
        response = await meteredCreate(anthropic, { companyId, userId: userId ?? null, subtipo: "whatsapp.agent" }, {
          model,
          max_tokens: MAX_TOKENS,
          system,
          tools,
          messages,
        });
      } else {
        throw err;
      }
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    if (toolUses.length === 0) {
      // No tool calls → this is the final answer. Concatenate text blocks.
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      return toWhatsappText(text) || "No tengo una respuesta para eso ahora mismo.";
    }

    // Execute tools and feed results back.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      let content: string;
      try {
        content = await executeToolCall(
          tu.name,
          tu.input as Record<string, unknown>,
          companyId,
          { conversationId, userId }
        );
      } catch (e) {
        content = `Error al ejecutar ${tu.name}: ${
          e instanceof Error ? e.message : "desconocido"
        }`;
      }
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content });
    }

    messages = [
      ...messages,
      { role: "assistant", content: response.content },
      { role: "user", content: toolResults },
    ];
    rounds++;
  }

  return "Esta consulta es más compleja de lo que puedo resolver por aquí. ¿Puedes preguntarlo de otra forma o revisarlo en la aplicación?";
}

/**
 * Safety net: WhatsApp doesn't render markdown. Convert **bold** → *bold*,
 * strip leading ## headings, and drop stray code fences, so even if the model
 * slips past the prompt instructions the user never sees literal markdown.
 */
function toWhatsappText(s: string): string {
  return s
    .replace(/```[a-z]*\n?/gi, "") // code fences
    .replace(/\*\*([^*]+)\*\*/g, "*$1*") // **bold** → *bold*
    .replace(/^#{1,6}\s+/gm, "") // ## headings → plain
    .replace(/^\s*[-*]\s+/gm, "- ") // normalize bullets
    .trim();
}

/** Nombre y tono del copiloto de esta persona (User.onboarding) y los estados de la empresa. */
async function identidadCopiloto(userId: string | undefined, companyId: string): Promise<IdentidadCopiloto> {
  const [u, entidades] = await Promise.all([
    userId ? prisma.user.findUnique({ where: { id: userId }, select: { onboarding: true } }) : null,
    entidadesDeEmpresa(companyId).then((e) => e.todas).catch(() => [] as string[]),
  ]);
  const raw = (u?.onboarding ?? {}) as Record<string, unknown>;
  return { nombre: nombreDe(sanearPiel(raw.piel)), tono: sanearProgreso(raw).tono, entidades };
}
