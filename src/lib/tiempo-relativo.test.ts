import { describe, it, expect } from "vitest";
import { haceCuanto } from "./tiempo-relativo";

const AHORA = new Date("2026-09-07T12:00:00Z").getTime();
const hace = (ms: number) => new Date(AHORA - ms);

describe("haceCuanto", () => {
  it("dice la unidad que se entiende, no minutos siempre", () => {
    expect(haceCuanto(hace(30_000), AHORA)).toBe("hace un momento");
    expect(haceCuanto(hace(40 * 60_000), AHORA)).toBe("hace 40 min");
    expect(haceCuanto(hace(5 * 3_600_000), AHORA)).toBe("hace 5 h");
    // El caso que motivó esto: «hace 6038 min» en pantalla.
    expect(haceCuanto(hace(6038 * 60_000), AHORA)).toBe("hace 4 días");
    expect(haceCuanto(hace(45 * 86_400_000), AHORA)).toBe("hace 2 meses");
    expect(haceCuanto(hace(400 * 86_400_000), AHORA)).toBe("hace 1 año");
  });

  it("no viaja al futuro ni revienta con basura", () => {
    expect(haceCuanto(new Date(AHORA + 99_999), AHORA)).toBe("hace un momento");
    expect(haceCuanto("no es fecha", AHORA)).toBe("");
  });
});
