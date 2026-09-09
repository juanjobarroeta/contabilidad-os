import { describe, expect, it } from "vitest";
import {
  diasEntreFechasCalendario,
  fechaFiscalEnMexico,
  periodoMensualActual,
  periodoMensualPorDefecto,
  rangoPeriodoMensual,
} from "./periodo-operativo";

describe("periodoMensualPorDefecto", () => {
  it("opens August while September 2026 is in progress", () => {
    expect(periodoMensualPorDefecto(new Date("2026-09-07T18:00:00Z"))).toEqual({
      year: 2026,
      month: 8,
      key: "2026-08",
    });
  });

  it("crosses the January year boundary", () => {
    expect(periodoMensualPorDefecto(new Date("2026-01-15T18:00:00Z"))).toEqual({
      year: 2025,
      month: 12,
      key: "2025-12",
    });
  });

  it("uses Mexico City instead of the Railway UTC calendar near midnight", () => {
    // 00:30 UTC on September 1 is still August 31 in Mexico City.
    expect(periodoMensualPorDefecto(new Date("2026-09-01T00:30:00Z"))).toEqual({
      year: 2026,
      month: 7,
      key: "2026-07",
    });
  });

  it("keeps the current month and database range on the Mexico calendar", () => {
    const current = periodoMensualActual(new Date("2026-09-01T00:30:00Z"));
    expect(current).toEqual({ year: 2026, month: 8, key: "2026-08" });

    const range = rangoPeriodoMensual(current);
    expect(range.from.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(range.to.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("exposes the same Mexico calendar date for deadline comparisons", () => {
    expect(fechaFiscalEnMexico(new Date("2026-09-18T04:30:00Z")).key).toBe("2026-09-17");
  });

  it("counts calendar days without daylight or runtime timezone drift", () => {
    expect(diasEntreFechasCalendario("2026-09-10", "2026-09-17")).toBe(7);
    expect(diasEntreFechasCalendario("2026-12-31", "2027-01-01")).toBe(1);
  });
});
