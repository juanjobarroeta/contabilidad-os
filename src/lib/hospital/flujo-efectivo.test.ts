import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { fechasNomina, semanaDe } from "./flujo-efectivo";

const d = (s: string) => new Date(`${s}T12:00:00Z`);

describe("flujo de efectivo", () => {
  it("lo vencido cae en la primera semana y lo que sale del horizonte no cuenta", () => {
    const inicio = d("2026-09-28");
    expect(semanaDe(d("2026-09-01"), inicio, 8)).toBe(0);
    expect(semanaDe(d("2026-10-06"), inicio, 8)).toBe(1);
    expect(semanaDe(d("2026-12-31"), inicio, 8)).toBeNull();
  });
  it("la nómina se proyecta con la periodicidad de las dos últimas corridas", () => {
    const f = fechasNomina([d("2026-09-15"), d("2026-09-30")], d("2026-11-01"));
    expect(f.map((x) => x.toISOString().slice(0, 10))).toEqual(["2026-10-15", "2026-10-30"]);
    expect(fechasNomina([], d("2026-11-01"))).toEqual([]);
    expect(fechasNomina([d("2026-09-30")], d("2026-10-20"))).toHaveLength(1);
  });
});
