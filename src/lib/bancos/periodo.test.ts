import { describe, expect, it } from "vitest";
import { periodoDe } from "./import";

const d = (iso: string) => ({ fecha: new Date(`${iso}T12:00:00.000Z`) });

describe("periodoDe", () => {
  it("un solo mes → AAAA-MM", () => {
    expect(periodoDe([d("2026-08-26"), d("2026-08-31"), d("2026-08-28")])).toBe("2026-08");
  });
  it("cruza de mes → rango de fechas", () => {
    expect(periodoDe([d("2026-09-01"), d("2026-08-26")])).toBe("2026-08-26 – 2026-09-01");
  });
  it("un solo movimiento → su mes", () => {
    expect(periodoDe([d("2026-07-04")])).toBe("2026-07");
  });
  it("sin movimientos → null", () => {
    expect(periodoDe([])).toBeNull();
  });
});
