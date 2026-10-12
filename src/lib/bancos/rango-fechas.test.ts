import { describe, expect, it } from "vitest";
import { rangoDeFechas } from "./rango-fechas";

const iso = (d?: Date) => d?.toISOString().slice(0, 10);

describe("rangoDeFechas", () => {
  it("un mes: del día 1 al día 1 del siguiente", () => {
    const r = rangoDeFechas({ mes: "2026-08" });
    expect([iso(r?.gte), iso(r?.lt)]).toEqual(["2026-08-01", "2026-09-01"]);
  });
  it("diciembre cruza el año", () => {
    expect(iso(rangoDeFechas({ mes: "2026-12" })?.lt)).toBe("2027-01-01");
  });
  it("un rango es inclusivo en los dos extremos", () => {
    const r = rangoDeFechas({ desde: "2026-01-01", hasta: "2026-10-12" });
    expect([iso(r?.gte), iso(r?.lt)]).toEqual(["2026-01-01", "2026-10-13"]);
  });
  it("el rango manda sobre el mes", () => {
    expect(iso(rangoDeFechas({ mes: "2026-08", desde: "2026-01-01" })?.gte)).toBe("2026-01-01");
  });
  it("cualquiera de los dos extremos puede faltar", () => {
    expect(rangoDeFechas({ hasta: "2026-03-31" })).toEqual({ lt: new Date(Date.UTC(2026, 3, 1)) });
    expect(rangoDeFechas({ desde: "2026-03-01" })).toEqual({ gte: new Date(Date.UTC(2026, 2, 1)) });
  });
  it("fechas inválidas o vacías: sin filtro", () => {
    expect(rangoDeFechas({})).toBeNull();
    expect(rangoDeFechas({ mes: "2026-13" })).toBeNull();
    expect(rangoDeFechas({ desde: "2026-02-31" })).toBeNull();
    expect(rangoDeFechas({ desde: "ayer" })).toBeNull();
  });
});
