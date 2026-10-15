import { beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

type Bloque = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };
const estado = vi.hoisted(() => ({
  respuestas: [] as Array<{ content: Bloque[]; stop_reason: string }>,
  llamadas: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/ai/guardia", () => ({ asegurarUsoIA: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/costos/anthropic", () => ({
  meteredCreate: vi.fn(async (_c: unknown, _ctx: unknown, params: Record<string, unknown>) => {
    estado.llamadas.push({ ...params, messages: structuredClone(params.messages) });
    const r = estado.respuestas.shift();
    if (!r) throw new Error("sin respuesta preparada");
    return { model: params.model, ...r, usage: { input_tokens: 10, output_tokens: 5 } };
  }),
}));

import { MAX_RESULTADO_HERRAMIENTA, llamarModelo } from "./modelo";

const tools = [{ name: "consultar_inventario", input_schema: { type: "object" as const } }] as Anthropic.Tool[];
const base = { companyId: "c1", userId: "u1", subtipo: "hospital.ayuda", system: "sistema", user: "¿hay ondansetron?", cliente: {} as Anthropic };
const usa = (id: string, input: unknown = { texto: "ondansetron" }): Bloque => ({ type: "tool_use", id, name: "consultar_inventario", input });

beforeEach(() => {
  estado.respuestas = [];
  estado.llamadas = [];
});

describe("llamarModelo con herramientas", () => {
  it("ejecuta lo que pide el modelo, le devuelve los resultados y luego toma el JSON", async () => {
    const ejecutar = vi.fn(async () => ({ encontrados: 1, insumos: [{ nombre: "ONDANSETRON", existencia: 12 }] }));
    estado.respuestas = [
      { content: [{ type: "text", text: "Reviso." }, usa("t1"), usa("t2", { texto: "MSI0091" })], stop_reason: "tool_use" },
      { content: [{ type: "text", text: '{"respuesta":"Hay 12."}' }], stop_reason: "end_turn" },
    ];
    const r = await llamarModelo({ ...base, herramientas: { tools, ejecutar } });
    expect(r.datos).toEqual({ respuesta: "Hay 12." });
    expect(r.herramientasUsadas).toEqual(["consultar_inventario", "consultar_inventario"]);
    expect(r.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    expect(ejecutar).toHaveBeenCalledWith("consultar_inventario", { texto: "MSI0091" });
    expect(estado.llamadas[0].tools).toBe(tools);
    expect(estado.llamadas[0].system).toEqual([{ type: "text", text: "sistema", cache_control: { type: "ephemeral" } }]);
    const segunda = estado.llamadas[1].messages as Anthropic.MessageParam[];
    expect(segunda).toHaveLength(3);
    expect(segunda[1].role).toBe("assistant");
    // Todos los resultados en UN mensaje del usuario, ligados a su tool_use.
    expect(segunda[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: expect.stringContaining('"existencia":12') },
        { type: "tool_result", tool_use_id: "t2", content: expect.any(String) },
      ],
    });
  });

  it("si la herramienta lanza, el modelo recibe un error y sigue", async () => {
    estado.respuestas = [
      { content: [usa("t1")], stop_reason: "tool_use" },
      { content: [{ type: "text", text: '{"respuesta":"No pude consultar."}' }], stop_reason: "end_turn" },
    ];
    const r = await llamarModelo({ ...base, herramientas: { tools, ejecutar: async () => { throw new Error("db caída"); } } });
    expect(r.datos.respuesta).toBe("No pude consultar.");
    const res = (estado.llamadas[1].messages as Anthropic.MessageParam[])[2].content as Anthropic.ToolResultBlockParam[];
    expect(res[0]).toMatchObject({ is_error: true });
    expect(JSON.stringify(res)).not.toContain("db caída");
  });

  it("recorta resultados enormes", async () => {
    estado.respuestas = [
      { content: [usa("t1")], stop_reason: "tool_use" },
      { content: [{ type: "text", text: '{"respuesta":"ok"}' }], stop_reason: "end_turn" },
    ];
    await llamarModelo({ ...base, herramientas: { tools, ejecutar: async () => ({ x: "a".repeat(50_000) }) } });
    const res = (estado.llamadas[1].messages as Anthropic.MessageParam[])[2].content as Anthropic.ToolResultBlockParam[];
    expect((res[0].content as string).length).toBeLessThan(MAX_RESULTADO_HERRAMIENTA + 100);
  });

  it("tras maxRondas lo obliga a contestar sin herramientas", async () => {
    estado.respuestas = [
      { content: [usa("t1")], stop_reason: "tool_use" },
      { content: [usa("t2")], stop_reason: "tool_use" },
      { content: [{ type: "text", text: '{"respuesta":"listo"}' }], stop_reason: "end_turn" },
    ];
    await llamarModelo({ ...base, herramientas: { tools, ejecutar: async () => ({}), maxRondas: 2 } });
    expect(estado.llamadas.map((l) => l.tool_choice)).toEqual([undefined, undefined, { type: "none" }]);
  });

  it("sin herramientas no manda tools y el system va como texto", async () => {
    estado.respuestas = [{ content: [{ type: "text", text: '{"a":1}' }], stop_reason: "end_turn" }];
    const r = await llamarModelo(base);
    expect(estado.llamadas[0]).not.toHaveProperty("tools");
    expect(estado.llamadas[0].system).toBe("sistema");
    expect(r.herramientasUsadas).toEqual([]);
  });
});
