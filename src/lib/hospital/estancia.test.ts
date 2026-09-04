import { describe, it, expect } from "vitest";
import { nochesDeEstancia, nochesTranscurridas } from "./estancia";
import { fechaLocal } from "./tz";

describe("nochesDeEstancia (noches calendario locales)", () => {
  const ingreso = fechaLocal(2026, 9, 2, 8, 20);

  it("el mismo día no hay noche", () => {
    expect(nochesDeEstancia(ingreso, fechaLocal(2026, 9, 2, 23, 59))).toBe(0);
  });

  it("cruzar la medianoche local es una noche, aunque sean las 00:10", () => {
    expect(nochesDeEstancia(ingreso, fechaLocal(2026, 9, 3, 0, 10))).toBe(1);
    expect(nochesDeEstancia(ingreso, fechaLocal(2026, 9, 3, 10, 0))).toBe(1);
    expect(nochesDeEstancia(ingreso, fechaLocal(2026, 9, 5, 6, 30))).toBe(3);
  });

  it("un ingreso a las 23:50 cuenta la noche a los diez minutos", () => {
    expect(nochesDeEstancia(fechaLocal(2026, 9, 2, 23, 50), fechaLocal(2026, 9, 3, 0, 5))).toBe(1);
  });

  it("la medianoche se mide en CDMX, no en UTC", () => {
    // 20:00 local del 2 sep = 02:00Z del 3 sep: en UTC ya cambió el día, aquí no.
    expect(nochesDeEstancia(ingreso, new Date("2026-09-03T02:00:00.000Z"))).toBe(0);
  });

  it("hasta antes del ingreso (programado) es cero", () => {
    expect(nochesDeEstancia(ingreso, fechaLocal(2026, 9, 1))).toBe(0);
  });
});

describe("nochesTranscurridas", () => {
  const ingreso = fechaLocal(2026, 9, 2, 8, 20);

  it("devuelve la medianoche local de cada noche, empezando por la del ingreso", () => {
    const noches = nochesTranscurridas(ingreso, null, fechaLocal(2026, 9, 4, 6, 30));
    expect(noches.map((n) => n.toISOString())).toEqual([
      "2026-09-02T06:00:00.000Z",
      "2026-09-03T06:00:00.000Z",
    ]);
  });

  it("el alta corta el conteo aunque hoy sea después", () => {
    const noches = nochesTranscurridas(ingreso, fechaLocal(2026, 9, 3, 13, 5), fechaLocal(2026, 9, 10));
    expect(noches).toHaveLength(1);
  });

  it("un alta futura (programada) no cuenta más allá de hoy", () => {
    expect(nochesTranscurridas(ingreso, fechaLocal(2026, 9, 9), fechaLocal(2026, 9, 3, 10))).toHaveLength(1);
  });
});
