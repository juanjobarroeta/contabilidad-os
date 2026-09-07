import { describe, it, expect } from "vitest";
import { evidenciaPresentacion, tieneAcuse } from "./presentacion";

describe("evidenciaPresentacion", () => {
  it("sin fila: no está presentada y no hay nada que probar", () => {
    const e = evidenciaPresentacion(null);
    expect(e.presentada).toBe(false);
    expect(e.conEvidencia).toBe(false);
    expect(e.origen).toBe("ninguno");
  });

  it("acuse PDF del backfill: presentada con evidencia descargable", () => {
    const e = evidenciaPresentacion({
      status: "FILED",
      isHistorical: true,
      acusePdfNombre: "acuse-2025.pdf",
      fechaPresentacion: new Date("2026-03-28T00:00:00Z"),
    });
    expect(e.presentada).toBe(true);
    expect(e.conEvidencia).toBe(true);
    expect(e.origen).toBe("acuse");
    expect(e.acuseDescargable).toBe(true);
    expect(e.etiqueta).toContain("acuse del SAT");
    expect(e.etiqueta).toContain("2026");
  });

  it("línea de captura sin PDF: la presentación consta, el documento no", () => {
    const e = evidenciaPresentacion({ status: "FILED", lineaCaptura: "0126ABCD" });
    expect(e.origen).toBe("sat");
    expect(e.conEvidencia).toBe(true);
    expect(e.acuseDescargable).toBe(false);
  });

  it("marcada a mano: presentada, pero SIN evidencia (y lo dice)", () => {
    const e = evidenciaPresentacion({ status: "FILED" });
    expect(e.presentada).toBe(true);
    expect(e.conEvidencia).toBe(false);
    expect(e.origen).toBe("manual");
    expect(e.etiqueta).toContain("a mano");
  });

  it("calculada sin rastros: no presentada", () => {
    expect(evidenciaPresentacion({ status: "CALCULATED" }).presentada).toBe(false);
  });

  it("PAID cuenta como presentada", () => {
    expect(evidenciaPresentacion({ status: "PAID" }).presentada).toBe(true);
  });

  it("el acuse manda aunque el status se haya quedado atrás", () => {
    const e = evidenciaPresentacion({ status: "CALCULATED", acuseUrl: "https://sat/acuse" });
    expect(e.presentada).toBe(true);
    expect(e.origen).toBe("acuse");
  });

  it("tieneAcuse conserva la definición que usaba la apertura", () => {
    expect(tieneAcuse({ acuseData: { filed: {} } })).toBe(true);
    expect(tieneAcuse({ fechaPresentacion: new Date() })).toBe(true);
    expect(tieneAcuse({ status: "FILED" })).toBe(false);
  });
});
