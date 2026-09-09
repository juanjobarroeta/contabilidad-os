import { describe, expect, it } from "vitest";
import { diasDesde, severidadAnticipo, DIAS_ATENCION, DIAS_VENCIDO } from "./anticipos";

describe("severidadAnticipo — la antigüedad ES el riesgo", () => {
  it("recién cobrado: nadie ha hecho nada mal todavía", () => {
    expect(severidadAnticipo(0)).toBe("reciente");
    expect(severidadAnticipo(DIAS_ATENCION - 1)).toBe("reciente");
  });

  it("más de una semana: pide atención", () => {
    expect(severidadAnticipo(DIAS_ATENCION)).toBe("atencion");
    expect(severidadAnticipo(DIAS_VENCIDO - 1)).toBe("atencion");
  });

  it("un mes sin CFDI ya no es descuido de calendario: es exposición", () => {
    // El CFDI de anticipo se emite AL RECIBIR el pago; a los 30 días el IVA de
    // ese cobro se causó y no se declaró.
    expect(severidadAnticipo(DIAS_VENCIDO)).toBe("vencido");
    expect(severidadAnticipo(120)).toBe("vencido");
  });
});

describe("diasDesde", () => {
  const hoy = new Date("2026-09-09T12:00:00Z");

  it("cuenta días completos", () => {
    expect(diasDesde(new Date("2026-09-09T00:00:00Z"), hoy)).toBe(0);
    expect(diasDesde(new Date("2026-08-31T12:00:00Z"), hoy)).toBe(9);
    expect(diasDesde(new Date("2026-06-01T12:00:00Z"), hoy)).toBe(100);
  });

  it("una fecha futura no da días negativos", () => {
    expect(diasDesde(new Date("2026-10-01T12:00:00Z"), hoy)).toBe(0);
  });
});
