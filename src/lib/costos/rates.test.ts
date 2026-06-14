import { describe, it, expect } from "vitest";
import {
  llmCostMicroUsd,
  syntageExtractionMicroUsd,
  microUsdACentavosMxn,
  SYNTAGE_EXTRACTION_USD,
  MICRO_USD,
} from "./rates";

describe("llmCostMicroUsd", () => {
  it("prices Sonnet tokens (micro-USD = inTok·$in/Mtok + outTok·$out/Mtok)", () => {
    // 2000 in × $3/Mtok + 1000 out × $15/Mtok = $0.006 + $0.015 = $0.021 = 21000 µUSD
    expect(llmCostMicroUsd("claude-sonnet-4-5", 2000, 1000)).toBe(21_000);
  });
  it("falls back to the default model for unknown ids", () => {
    expect(llmCostMicroUsd("some-unknown-model", 1_000_000, 0)).toBe(
      llmCostMicroUsd("claude-sonnet-4-5", 1_000_000, 0),
    );
    // 1M input tokens of Sonnet ($3/Mtok) = $3 = 3,000,000 µUSD
    expect(llmCostMicroUsd("claude-sonnet-4-5", 1_000_000, 0)).toBe(3_000_000);
  });
  it("is zero for zero tokens", () => {
    expect(llmCostMicroUsd("claude-sonnet-4-5", 0, 0)).toBe(0);
  });
});

describe("syntageExtractionMicroUsd", () => {
  it("converts the configured per-extraction USD price to micro-USD", () => {
    expect(syntageExtractionMicroUsd()).toBe(Math.round(SYNTAGE_EXTRACTION_USD * MICRO_USD));
  });
});

describe("microUsdACentavosMxn", () => {
  it("converts micro-USD to MXN cents at the given FIX", () => {
    // $0.021 × 20 MXN/USD = 0.42 MXN = 42 centavos
    expect(microUsdACentavosMxn(21_000, 20)).toBe(42);
  });
  it("is zero at zero cost", () => {
    expect(microUsdACentavosMxn(0, 18.5)).toBe(0);
  });
});
