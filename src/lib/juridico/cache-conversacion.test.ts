import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { marcarCacheDeConversacion } from "./turno-abogado";

const marcados = (ms: Anthropic.MessageParam[]) =>
  ms.flatMap((m, i) => (Array.isArray(m.content) ? m.content.map((b, j) => (typeof b !== "string" && "cache_control" in b && b.cache_control ? `${i}.${j}` : null)) : [])).filter(Boolean);

describe("caché de la conversación", () => {
  it("marca el último bloque del último mensaje, y sólo ése", () => {
    const ms: Anthropic.MessageParam[] = [
      { role: "user", content: [{ type: "text", text: "hola" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "buscar", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "art. 1" }, { type: "tool_result", tool_use_id: "t2", content: "art. 2" }] },
    ];
    expect(marcados(marcarCacheDeConversacion(ms))).toEqual(["2.1"]);
  });

  it("el marcador RODA: el de la ronda anterior se quita (el API sólo admite cuatro)", () => {
    const ronda1 = marcarCacheDeConversacion([
      { role: "user", content: [{ type: "text", text: "pregunta" }] },
    ]);
    expect(marcados(ronda1)).toEqual(["0.0"]);
    const ronda2 = marcarCacheDeConversacion([
      ...ronda1,
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "resultado" }] },
    ]);
    expect(marcados(ronda2)).toEqual(["2.0"]);
  });

  it("no toca el contenido ni el orden, y aguanta mensajes de texto plano", () => {
    const ms: Anthropic.MessageParam[] = [
      { role: "user", content: "texto plano" },
      { role: "assistant", content: [{ type: "text", text: "respuesta" }] },
    ];
    const out = marcarCacheDeConversacion(ms);
    expect(out[0].content).toBe("texto plano");
    expect(marcados(out)).toEqual(["1.0"]);
    expect(out).toHaveLength(2);
  });
});
