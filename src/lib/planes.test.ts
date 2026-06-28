import { describe, it, expect } from "vitest";
import { timbresExcedente, TIMBRES_INCLUIDOS } from "./planes";

describe("timbresExcedente", () => {
  it("0 cuando está dentro de la cuota del tier", () => {
    expect(timbresExcedente("AUTOMATIZADO", TIMBRES_INCLUIDOS.AUTOMATIZADO - 1)).toBe(0);
    expect(timbresExcedente("AUTOMATIZADO", TIMBRES_INCLUIDOS.AUTOMATIZADO)).toBe(0);
  });
  it("cuenta sólo lo que pasa de la cuota", () => {
    expect(timbresExcedente("AUTOMATIZADO", TIMBRES_INCLUIDOS.AUTOMATIZADO + 12)).toBe(12);
  });
  it("ASISTENTE tiene la cuota más baja", () => {
    expect(TIMBRES_INCLUIDOS.ASISTENTE).toBeLessThan(TIMBRES_INCLUIDOS.AUTOMATIZADO);
  });
});
