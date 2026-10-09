import { describe, expect, it } from "vitest";
import { ajustarParams, sinRazonamiento } from "./modelos";
import { cacheEnUltimoMensaje } from "./cache-conversacion";
import { llmCostMicroUsd, modeloConTarifa } from "@/lib/costos/rates";

describe("sinRazonamiento / ajustarParams", () => {
  it("apaga el pensamiento según lo que acepta cada modelo", () => {
    expect(sinRazonamiento("claude-haiku-5-5")).toEqual({ thinking: { type: "disabled" } });
    expect(sinRazonamiento("claude-sonnet-5-5")).toEqual({ thinking: { type: "between_tools" } });
    expect(sinRazonamiento("claude-opus-5-5")).toEqual({});
    expect(sinRazonamiento("claude-sonnet-4-6")).toEqual({});
    expect(sinRazonamiento("claude-haiku-4-5-20251001")).toEqual({});
  });
  it("no pisa un thinking configurado por la llamada", () => {
    const p = { model: "claude-haiku-5-5", thinking: { type: "adaptive" } };
    expect(ajustarParams(p)).toBe(p);
    expect(ajustarParams({ model: "claude-haiku-5-5", max_tokens: 10 })).toEqual({ model: "claude-haiku-5-5", max_tokens: 10, thinking: { type: "disabled" } });
  });
});

describe("cacheEnUltimoMensaje", () => {
  it("marca sólo el último bloque y no muta el original", () => {
    const msgs = [
      { role: "user" as const, content: "hola" },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "¿qué tal?" }] },
      { role: "user" as const, content: "dime el saldo" },
    ];
    const out = cacheEnUltimoMensaje(msgs);
    expect(out[2].content).toEqual([{ type: "text", text: "dime el saldo", cache_control: { type: "ephemeral" } }]);
    expect(out[0]).toBe(msgs[0]);
    expect(msgs[2].content).toBe("dime el saldo");
    expect(JSON.stringify(out).match(/cache_control/g)).toHaveLength(1);
  });
  it("marca el último tool_result de la ronda", () => {
    const out = cacheEnUltimoMensaje([{ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "x" }, { type: "tool_result", tool_use_id: "b", content: "y" }] }]);
    const c = out[0].content as unknown as Array<Record<string, unknown>>;
    expect(c[0].cache_control).toBeUndefined();
    expect(c[1].cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("tarifas de los modelos nuevos", () => {
  it("tienen renglón propio (no caen al default de Sonnet 4.5)", () => {
    for (const m of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]) expect(modeloConTarifa(m)).toBe(true);
    expect(llmCostMicroUsd("claude-haiku-5-5", 1_000_000, 1_000_000)).toBe(600_000);
  });
});
