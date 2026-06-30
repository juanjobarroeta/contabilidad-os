import { describe, it, expect } from "vitest";
import { decideChatBudget } from "./budget";

describe("decideChatBudget — tope mensual de LLM del chat in-app", () => {
  it("permite por debajo del tope", () => {
    expect(decideChatBudget({ monthlyLlmUsd: 3, limitUsd: 8 }).allowed).toBe(true);
  });

  it("bloquea al alcanzar el tope", () => {
    const d = decideChatBudget({ monthlyLlmUsd: 8, limitUsd: 8 });
    expect(d.allowed).toBe(false);
    expect(d.mensaje).toMatch(/límite mensual/i);
  });

  it("bloquea por encima del tope", () => {
    expect(decideChatBudget({ monthlyLlmUsd: 12, limitUsd: 8 }).allowed).toBe(false);
  });

  it("permite justo por debajo (tope - epsilon)", () => {
    expect(decideChatBudget({ monthlyLlmUsd: 7.99, limitUsd: 8 }).allowed).toBe(true);
  });
});
