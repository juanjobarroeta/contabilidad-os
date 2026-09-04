import { describe, it, expect } from "vitest";
import { consecutivoDeFolio, formatearFolio, siguienteConsecutivo } from "./folio";

describe("folio", () => {
  it("formatea prefijo-año-consecutivo de 4 dígitos", () => {
    expect(formatearFolio("HOSP", 2026, 418)).toBe("HOSP-2026-0418");
    expect(formatearFolio("COT", 2026, 1)).toBe("COT-2026-0001");
    expect(formatearFolio("MANT", 2027, 12345)).toBe("MANT-2027-12345");
  });

  it("lee el consecutivo sólo de folios de la misma serie y año", () => {
    expect(consecutivoDeFolio("HOSP-2026-0418", "HOSP", 2026)).toBe(418);
    expect(consecutivoDeFolio("HOSP-2025-0418", "HOSP", 2026)).toBeNull();
    expect(consecutivoDeFolio("COT-2026-0418", "HOSP", 2026)).toBeNull();
    expect(consecutivoDeFolio("HOSP-2026-abc", "HOSP", 2026)).toBeNull();
  });

  it("el siguiente es filas + 1, sin bajar del mayor emitido", () => {
    expect(siguienteConsecutivo([], "HOSP", 2026)).toBe(1);
    expect(siguienteConsecutivo(["HOSP-2026-0001", "HOSP-2026-0002"], "HOSP", 2026)).toBe(3);
    // Un seed metió el 0418: la cuenta dice 2, el mayor dice 419.
    expect(siguienteConsecutivo(["HOSP-2026-0001", "HOSP-2026-0418"], "HOSP", 2026)).toBe(419);
    // Folios de otro año no cuentan: reinicia por año.
    expect(siguienteConsecutivo(["HOSP-2025-0900"], "HOSP", 2026)).toBe(1);
  });
});
