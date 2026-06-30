import { describe, it, expect } from "vitest";
import { siguienteEstado } from "./notificaciones";

const now = new Date("2026-06-30T12:00:00Z");
const futuro = new Date("2026-07-15T12:00:00Z");
const pasado = new Date("2026-06-01T12:00:00Z");

describe("siguienteEstado", () => {
  it("NUEVO re-disparado sigue NUEVO", () => {
    expect(siguienteEstado("NUEVO", null, now)).toBe("NUEVO");
  });

  it("VISTO re-disparado vuelve a NUEVO (alerta es nueva otra vez)", () => {
    expect(siguienteEstado("VISTO", null, now)).toBe("NUEVO");
  });

  it("HECHO re-disparado se respeta (no re-molestar)", () => {
    expect(siguienteEstado("HECHO", null, now)).toBe("HECHO");
    // HECHO se respeta aunque hubiera un posponerHasta colgando.
    expect(siguienteEstado("HECHO", pasado, now)).toBe("HECHO");
    expect(siguienteEstado("HECHO", futuro, now)).toBe("HECHO");
  });

  it("POSPUESTO vigente (snooze en el futuro) sigue POSPUESTO", () => {
    expect(siguienteEstado("POSPUESTO", futuro, now)).toBe("POSPUESTO");
  });

  it("POSPUESTO vencido (snooze en el pasado) reaparece como NUEVO", () => {
    expect(siguienteEstado("POSPUESTO", pasado, now)).toBe("NUEVO");
  });

  it("POSPUESTO sin fecha se trata como vencido → NUEVO", () => {
    expect(siguienteEstado("POSPUESTO", null, now)).toBe("NUEVO");
  });

  it("POSPUESTO exactamente en `now` ya no es futuro → NUEVO", () => {
    expect(siguienteEstado("POSPUESTO", now, now)).toBe("NUEVO");
  });
});
