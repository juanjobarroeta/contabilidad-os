import { describe, expect, it } from "vitest";
import { etiquetaPlazoRep, fechaLimiteRep, repVencido } from "./rep-plazo";

describe("plazo del REP (RMF 2.7.1.32: día 5 del mes siguiente)", () => {
  it("cobro del 20-jul → límite 5-ago fin de día", () => {
    const limite = fechaLimiteRep(new Date("2026-07-20T10:00:00Z"));
    expect(limite.toISOString().slice(0, 10)).toBe("2026-08-05");
  });

  it("cobro en diciembre cruza de año: límite 5-ene", () => {
    const limite = fechaLimiteRep(new Date("2026-12-28T10:00:00Z"));
    expect(limite.toISOString().slice(0, 10)).toBe("2027-01-05");
  });

  it("vencido sólo DESPUÉS del día 5 completo", () => {
    const pago = new Date("2026-07-20T10:00:00Z");
    expect(repVencido(pago, new Date("2026-08-05T23:00:00Z"))).toBe(false); // el día 5 aún se puede
    expect(repVencido(pago, new Date("2026-08-06T00:30:00Z"))).toBe(true);
  });

  it("la etiqueta conjuga según hoy", () => {
    const pago = new Date("2026-07-20T10:00:00Z");
    expect(etiquetaPlazoRep(pago, new Date("2026-08-01T00:00:00Z"))).toBe("vence el 5 de agosto");
    expect(etiquetaPlazoRep(pago, new Date("2026-08-10T00:00:00Z"))).toBe("venció el 5 de agosto");
  });
});
