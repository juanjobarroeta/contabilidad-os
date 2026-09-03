import type Anthropic from "@anthropic-ai/sdk";

// ── Límites del payload ──────────────────────────────────────────────────────
// El cliente manda el historial completo en cada turno. Sin tope, un cuerpo de
// varios MB (o bloques de imagen que el chat no ofrece) entra tal cual al modelo
// más caro, ×5 rondas. Nos quedamos con los últimos turnos y sólo texto y
// bloques de herramientas; el resto se rechaza.
export const MAX_BODY_BYTES = 200 * 1024;
const MAX_HISTORY_MESSAGES = 40;
const MAX_TEXT_CHARS_PER_MESSAGE = 20_000;
const TIPOS_BLOQUE_PERMITIDOS = new Set(["text", "tool_use", "tool_result"]);

/**
 * Sanea el historial que manda el cliente: sólo roles user/assistant, sólo
 * texto y bloques de herramientas, texto acotado, y como máximo los últimos
 * MAX_HISTORY_MESSAGES mensajes (empezando en un mensaje `user`, como exige la
 * API). Devuelve null si el cuerpo trae bloques no permitidos (imagen, documento).
 */
export function sanearHistorial(raw: unknown): Anthropic.MessageParam[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Anthropic.MessageParam[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") return null;
    const { role, content } = m as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") return null;
    if (typeof content === "string") {
      out.push({ role, content: content.slice(0, MAX_TEXT_CHARS_PER_MESSAGE) });
      continue;
    }
    if (!Array.isArray(content)) return null;
    const bloques: Anthropic.ContentBlockParam[] = [];
    for (const b of content) {
      const tipo = (b as { type?: unknown })?.type;
      if (typeof tipo !== "string" || !TIPOS_BLOQUE_PERMITIDOS.has(tipo)) return null;
      if (tipo === "text") {
        const t = (b as { text?: unknown }).text;
        if (typeof t !== "string") return null;
        bloques.push({ type: "text", text: t.slice(0, MAX_TEXT_CHARS_PER_MESSAGE) });
      } else if (tipo === "tool_result") {
        const tr = b as Anthropic.ToolResultBlockParam;
        // El contenido de un tool_result también puede traer bloques: sólo texto.
        if (Array.isArray(tr.content) && tr.content.some((c) => (c as { type?: string }).type !== "text")) return null;
        bloques.push(tr);
      } else {
        bloques.push(b as Anthropic.ContentBlockParam);
      }
    }
    out.push({ role, content: bloques });
  }
  let recorte = out.slice(-MAX_HISTORY_MESSAGES);
  // La conversación debe empezar en `user` (y no a media pareja tool_use/tool_result).
  while (recorte.length && (recorte[0].role !== "user" || Array.isArray(recorte[0].content) && recorte[0].content.some((c) => c.type === "tool_result"))) {
    recorte = recorte.slice(1);
  }
  return recorte;
}

