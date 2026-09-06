import { beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { HospitalError } from "../errores";

const estado = vi.hoisted(() => ({
  respuestas: [] as Array<{ text: string; model?: string; stop_reason?: string } | { status: number }>,
  llamadas: [] as Array<{ model: string; messages: unknown[]; max_tokens: number }>,
  guardia: { ok: true } as { ok: true } | { ok: false; status: 429; motivo: string; mensaje: string },
}));

vi.mock("@/lib/ai/guardia", () => ({ asegurarUsoIA: vi.fn(async () => estado.guardia) }));
vi.mock("@/lib/costos/anthropic", () => ({
  meteredCreate: vi.fn(async (_c: unknown, _ctx: unknown, params: { model: string; messages: unknown[]; max_tokens: number }) => {
    estado.llamadas.push({ model: params.model, messages: params.messages, max_tokens: params.max_tokens });
    const r = estado.respuestas.shift();
    if (!r) throw new Error("sin respuesta preparada");
    if ("status" in r) throw Object.assign(new Error(`api ${r.status}`), { status: r.status });
    return { model: r.model ?? params.model, stop_reason: r.stop_reason ?? "end_turn", content: [{ type: "text", text: r.text }], usage: { input_tokens: 10, output_tokens: 5 } };
  }),
}));

import { MODELO_DEFAULT, MODELO_RESPALDO_DEFAULT, llamarModelo, parsearJsonEstricto } from "./modelo";

const cliente = {} as Anthropic;
const base = { companyId: "c1", userId: "u1", subtipo: "hospital.asistente.prueba", system: "sistema", user: "usuario", cliente };

beforeEach(() => {
  estado.respuestas = [];
  estado.llamadas = [];
  estado.guardia = { ok: true };
  delete process.env.AI_HOSPITAL_MODEL;
  delete process.env.AI_HOSPITAL_MODEL_FALLBACK;
});

describe("parsearJsonEstricto", () => {
  it("acepta JSON limpio, con fences o con prosa alrededor", () => {
    expect(parsearJsonEstricto('{"a":1}')).toEqual({ a: 1 });
    expect(parsearJsonEstricto('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parsearJsonEstricto('Aquí va:\n{"a":{"b":[1,2]}}\nListo.')).toEqual({ a: { b: [1, 2] } });
  });

  it("rechaza lo que no es un objeto", () => {
    expect(parsearJsonEstricto("[1,2]")).toBeNull();
    expect(parsearJsonEstricto('{"a":')).toBeNull();
    expect(parsearJsonEstricto("sin json")).toBeNull();
    expect(parsearJsonEstricto("")).toBeNull();
  });
});

describe("llamarModelo", () => {
  it("devuelve el objeto y el modelo que contestó", async () => {
    estado.respuestas = [{ text: '{"secciones":{"plan":"Alta"}}' }];
    const r = await llamarModelo(base);
    expect(r.datos).toEqual({ secciones: { plan: "Alta" } });
    expect(r.modelo).toBe(MODELO_DEFAULT);
    expect(r.intentos).toBe(1);
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(estado.llamadas[0].messages).toEqual([{ role: "user", content: "usuario" }]);
  });

  it("reintenta UNA vez cuando la respuesta no es JSON, enseñándole lo que contestó", async () => {
    estado.respuestas = [{ text: "Claro, aquí tienes la nota: …" }, { text: '{"ok":true}' }];
    const r = await llamarModelo(base);
    expect(r.datos).toEqual({ ok: true });
    expect(r.intentos).toBe(2);
    expect(estado.llamadas).toHaveLength(2);
    const segunda = estado.llamadas[1].messages as Array<{ role: string; content: string }>;
    expect(segunda.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(segunda[1].content).toContain("Claro, aquí tienes");
    expect(segunda[2].content).toMatch(/ÚNICAMENTE con el objeto JSON/);
    expect(r.usage.inputTokens).toBe(20);
  });

  it("si la segunda tampoco es JSON contesta 502 y no sigue reintentando", async () => {
    estado.respuestas = [{ text: "nada" }, { text: "tampoco" }, { text: '{"tarde":true}' }];
    await expect(llamarModelo(base)).rejects.toMatchObject({ status: 502 });
    expect(estado.llamadas).toHaveLength(2);
  });

  it("con la respuesta cortada por max_tokens reintenta con el doble de tokens", async () => {
    estado.respuestas = [{ text: '{"secciones":{"plan":"muy larg', stop_reason: "max_tokens" }, { text: '{"secciones":{"plan":"corto"}}' }];
    const r = await llamarModelo({ ...base, maxTokens: 1000 });
    expect(r.intentos).toBe(2);
    expect(estado.llamadas.map((l) => l.max_tokens)).toEqual([1000, 2000]);
    expect((estado.llamadas[1].messages as Array<{ content: string }>)[2].content).toMatch(/cortada/);
  });

  it("cae al modelo de respaldo cuando el principal no existe para la cuenta (404)", async () => {
    estado.respuestas = [{ status: 404 }, { text: '{"ok":1}' }];
    const r = await llamarModelo(base);
    expect(estado.llamadas.map((l) => l.model)).toEqual([MODELO_DEFAULT, MODELO_RESPALDO_DEFAULT]);
    expect(r.modelo).toBe(MODELO_RESPALDO_DEFAULT);
  });

  it("respeta AI_HOSPITAL_MODEL", async () => {
    process.env.AI_HOSPITAL_MODEL = "claude-sonnet-4-6";
    estado.respuestas = [{ text: "{}" }];
    await llamarModelo(base);
    expect(estado.llamadas[0].model).toBe("claude-sonnet-4-6");
  });

  it("no gasta cuando la guardia de IA niega (429 con el mensaje de la guardia)", async () => {
    estado.guardia = { ok: false, status: 429, motivo: "empresa", mensaje: "Tope mensual alcanzado" };
    await expect(llamarModelo(base)).rejects.toMatchObject({ status: 429, message: "Tope mensual alcanzado" });
    expect(estado.llamadas).toHaveLength(0);
  });

  it("sin ANTHROPIC_API_KEY ni cliente contesta 503 sin llamar", async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { cliente: _c, ...sinCliente } = base;
      const e = await llamarModelo(sinCliente).catch((x) => x);
      expect(e).toBeInstanceOf(HospitalError);
      expect(e.status).toBe(503);
      expect(estado.llamadas).toHaveLength(0);
    } finally {
      if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
    }
  });

  it("traduce las fallas del proveedor a 502/503 sin exponer el detalle", async () => {
    estado.respuestas = [{ status: 529 }];
    await expect(llamarModelo(base)).rejects.toMatchObject({ status: 503 });
    estado.respuestas = [{ status: 500 }];
    await expect(llamarModelo(base)).rejects.toMatchObject({ status: 502 });
  });

  it("un rechazo del modelo (refusal) es 502", async () => {
    estado.respuestas = [{ text: "", stop_reason: "refusal" }];
    await expect(llamarModelo(base)).rejects.toMatchObject({ status: 502 });
  });
});
