import type Anthropic from "@anthropic-ai/sdk";

/**
 * Copia de `messages` con un breakpoint de caché en el ÚLTIMO bloque.
 *
 * Sin esto, en un turno con herramientas cada ronda reenvía todo el historial
 * y los resultados de herramientas como entrada sin caché (el 80% del costo
 * del copiloto). Con el breakpoint al final, la ronda siguiente lee de caché
 * todo lo anterior (0.05–0.1× el precio) y sólo paga lo nuevo. No modifica el
 * arreglo original (se persiste tal cual) y deja sólo UN breakpoint en los
 * mensajes, para no rebasar el máximo de 4 por petición.
 */
export function cacheEnUltimoMensaje(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;
  const out = messages.slice();
  const last = out[out.length - 1];
  const bloques: Anthropic.ContentBlockParam[] = typeof last.content === "string"
    ? [{ type: "text", text: last.content }]
    : last.content.slice();
  if (bloques.length === 0) return messages;
  const i = bloques.length - 1;
  bloques[i] = { ...bloques[i], cache_control: { type: "ephemeral" } } as Anthropic.ContentBlockParam;
  out[out.length - 1] = { ...last, content: bloques };
  return out;
}
