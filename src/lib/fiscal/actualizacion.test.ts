import { describe, expect, it } from "vitest";
import { factorActualizacion, inpcPeriodo } from "./actualizacion";

describe("canonical INPC consumption", () => {
  it("reads historical and current values from the shared series", () => {
    expect(inpcPeriodo("2025-12")).toBe(143.042);
    expect(inpcPeriodo("2026-08")).toBe(145.462);
  });

  it("fails closed for missing or malformed periods", () => {
    expect(inpcPeriodo("2026-09")).toBeNull();
    expect(inpcPeriodo("2026/08")).toBeNull();
    expect(factorActualizacion("2025-12", "2026-09")).toBeNull();
  });

  it("preserves the historical factor after removing the duplicate supplement", () => {
    expect(factorActualizacion("2024-12", "2025-12")).toBe(1.0369);
  });
});
