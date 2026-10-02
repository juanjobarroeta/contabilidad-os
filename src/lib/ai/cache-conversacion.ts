import type Anthropic from "@anthropic-ai/sdk";

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
