import { describe, it, expect } from "vitest";
import { inpc, coberturaInpc, factorActualizacionDepreciacion } from "./inpc";

describe("inpc()", () => {
  it("returns loaded values (incl. sep–dic now seeded)", () => {
    expect(inpc(2025, 1)).toBe(138.343);
    expect(inpc(2023, 12)).toBe(132.373);
    expect(inpc(2024, 6)).toBe(134.594);
  });

  it("returns null for unloaded or out-of-range months", () => {
    expect(inpc(2026, 6)).toBeNull(); // junio 2026 aún no publicado
    expect(inpc(2025, 13)).toBeNull();
    expect(inpc(2025, 0)).toBeNull();
    expect(inpc(1999, 1)).toBeNull();
  });
});

describe("coberturaInpc()", () => {
  it("reports the latest loaded month", () => {
    expect(coberturaInpc()).toEqual({ year: 2026, month: 5 });
  });
});

describe("factorActualizacionDepreciacion() — Art. 31 LISR", () => {
  it("uses INPC(último mes 1ª mitad) / INPC(adquisición)", () => {
    const r = factorActualizacionDepreciacion({
      fechaAdquisicion: new Date(2023, 0, 15), // ene-2023
      ejercicio: 2024,
      startMonthIndex: 0,
      mesesUso: 12, // 1ª mitad = 6 → último mes = junio
    });
    expect(r.completo).toBe(true);
    expect(r.numerador).toMatchObject({ year: 2024, month: 6, inpc: 134.594 });
    expect(r.denominador).toMatchObject({ year: 2023, month: 1, inpc: 127.336 });
    expect(r.factor).toBeCloseTo(134.594 / 127.336, 4);
  });

  it("uses the prior month when the use period is odd (Art. 31)", () => {
    // mesesUso 11 → floor(11/2)=5 → último mes 1ª mitad = mayo (idx 4)
    const r = factorActualizacionDepreciacion({
      fechaAdquisicion: new Date(2023, 0, 1),
      ejercicio: 2024,
      startMonthIndex: 0,
      mesesUso: 11,
    });
    expect(r.numerador).toMatchObject({ year: 2024, month: 5, inpc: 134.087 });
  });

  it("falls back to nominal (factor 1, completo false) when an INPC is missing", () => {
    const r = factorActualizacionDepreciacion({
      fechaAdquisicion: new Date(2026, 5, 1), // jun-2026 no está cargado
      ejercicio: 2026,
      startMonthIndex: 0,
      mesesUso: 4,
    });
    expect(r).toMatchObject({ factor: 1, completo: false });
  });

  it("returns ~1 for very short use periods (< 2 meses)", () => {
    const r = factorActualizacionDepreciacion({
      fechaAdquisicion: new Date(2023, 0, 1),
      ejercicio: 2023,
      startMonthIndex: 0,
      mesesUso: 1,
    });
    expect(r).toEqual({ factor: 1, completo: true });
  });
});
