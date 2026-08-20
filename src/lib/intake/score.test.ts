import { describe, expect, it } from "vitest";
import { CORE_MULTIPLIER, computeScore, renderMovement, scoreInputsFromItem, FIELD_NAMES } from "./score";
import type { ProjectItem } from "./github";

describe("computeScore", () => {
  it("fórmula base: (mrr * confidence / effort) * core", () => {
    expect(computeScore({ mrrAtRisk: 1000, mrrUnlocked: 0, confidence: 0.8, effortDays: 4, core: false })).toBe(200);
    expect(computeScore({ mrrAtRisk: 1000, mrrUnlocked: 0, confidence: 0.8, effortDays: 4, core: true })).toBe(600);
  });

  it("el core multiplier empuja trabajo del motor por encima del satélite", () => {
    const satelite = computeScore({ mrrAtRisk: 2000, mrrUnlocked: 0, confidence: 1, effortDays: 2, core: false });
    const motor = computeScore({ mrrAtRisk: 800, mrrUnlocked: 0, confidence: 1, effortDays: 2, core: true });
    expect(motor).toBeGreaterThan(satelite);
    expect(CORE_MULTIPLIER).toBe(3);
  });

  it("effort se acota a 0.5 días (nada de dividir entre cero)", () => {
    expect(computeScore({ mrrAtRisk: 100, mrrUnlocked: 0, confidence: 1, effortDays: 0, core: false })).toBe(200);
  });

  it("confidence se acota a [0,1]", () => {
    expect(computeScore({ mrrAtRisk: 100, mrrUnlocked: 0, confidence: 5, effortDays: 1, core: false })).toBe(100);
  });
});

describe("scoreInputsFromItem", () => {
  function item(fields: ProjectItem["fields"]): ProjectItem {
    return { itemId: "i", issueNodeId: "n", issueUrl: null, title: "t", state: "OPEN", fields };
  }

  it("lee los campos por nombre con defaults sanos", () => {
    const inputs = scoreInputsFromItem(
      item({
        [FIELD_NAMES.mrrAtRisk]: 1500,
        [FIELD_NAMES.effort]: 3,
        [FIELD_NAMES.confidence]: 0.9,
        [FIELD_NAMES.core]: "Yes",
      })
    );
    expect(inputs).toEqual({ mrrAtRisk: 1500, mrrUnlocked: 0, confidence: 0.9, effortDays: 3, core: true });
  });

  it("sin campos: confidence 0.5, effort 1, core false", () => {
    expect(scoreInputsFromItem(item({}))).toEqual({
      mrrAtRisk: 0,
      mrrUnlocked: 0,
      confidence: 0.5,
      effortDays: 1,
      core: false,
    });
  });
});

describe("renderMovement", () => {
  it("marca nuevos, subidas, bajadas y sin cambio", () => {
    expect(renderMovement(1, "A", 900, null)).toContain("🆕");
    expect(renderMovement(1, "A", 900, 4)).toContain("▲3");
    expect(renderMovement(5, "A", 900, 2)).toContain("▼3");
    expect(renderMovement(3, "A", 900, 3)).toContain("＝");
  });
});
