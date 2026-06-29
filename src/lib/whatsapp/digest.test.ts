import { describe, it, expect } from "vitest";
import { formatCarteraDigest, formatCarteraDigestSummaryLine } from "./digest";

describe("formatCarteraDigest", () => {
  it("devuelve null cuando el usuario no tiene empresas", () => {
    expect(formatCarteraDigest([])).toBeNull();
  });

  it("'todo al corriente' cuando ninguna empresa tiene hallazgos", () => {
    const txt = formatCarteraDigest([
      { razonSocial: "A", hallazgos: 0, criticos: 0 },
      { razonSocial: "B", hallazgos: 0, criticos: 0 },
    ]);
    expect(txt).toContain("2 empresas");
    expect(txt).toContain("al corriente");
    // No lista pendientes cuando todo está limpio.
    expect(txt).not.toContain("Con pendientes");
  });

  it("lista las empresas con pendientes ordenadas por críticos y luego por total", () => {
    const txt = formatCarteraDigest([
      { razonSocial: "Pocos", hallazgos: 1, criticos: 0 },
      { razonSocial: "Critica", hallazgos: 2, criticos: 1 },
      { razonSocial: "Muchos", hallazgos: 5, criticos: 0 },
      { razonSocial: "Limpia", hallazgos: 0, criticos: 0 },
    ])!;
    // Critica (1 crítico) va primero; luego Muchos (5) antes que Pocos (1).
    const iCrit = txt.indexOf("Critica");
    const iMuchos = txt.indexOf("Muchos");
    const iPocos = txt.indexOf("Pocos");
    expect(iCrit).toBeGreaterThan(-1);
    expect(iCrit).toBeLessThan(iMuchos);
    expect(iMuchos).toBeLessThan(iPocos);
    expect(txt).toContain("(1 crítico)");
    expect(txt).toContain("1 al corriente.");
  });

  it("singulariza correctamente (1 hallazgo, 1 crítico)", () => {
    const txt = formatCarteraDigest([{ razonSocial: "X", hallazgos: 1, criticos: 1 }])!;
    expect(txt).toContain("1 hallazgo (1 crítico)");
    expect(txt).not.toContain("hallazgos");
  });

  it("resume el excedente cuando hay más empresas con pendientes que el máximo listado", () => {
    const muchas = Array.from({ length: 12 }, (_, i) => ({
      razonSocial: `E${String(i).padStart(2, "0")}`,
      hallazgos: 12 - i, // distintos totales para orden estable
      criticos: 0,
    }));
    const txt = formatCarteraDigest(muchas)!;
    expect(txt).toMatch(/y \d+ empresas? más con pendientes\./);
  });
});

describe("formatCarteraDigestSummaryLine (variable de plantilla)", () => {
  it("es null sin empresas", () => {
    expect(formatCarteraDigestSummaryLine([])).toBeNull();
  });

  it("NUNCA contiene saltos de línea ni tabs (requisito de variable de plantilla)", () => {
    const linea = formatCarteraDigestSummaryLine([
      { razonSocial: "A", hallazgos: 3, criticos: 1 },
      { razonSocial: "B", hallazgos: 0, criticos: 0 },
      { razonSocial: "C", hallazgos: 2, criticos: 0 },
    ])!;
    expect(linea).not.toMatch(/[\n\t]/);
    expect(linea).toContain("2 empresas con pendientes");
    expect(linea).toContain("1 con críticos");
    expect(linea).toContain("1 al corriente");
  });

  it("caso todo al corriente en una sola línea", () => {
    const linea = formatCarteraDigestSummaryLine([
      { razonSocial: "A", hallazgos: 0, criticos: 0 },
      { razonSocial: "B", hallazgos: 0, criticos: 0 },
    ])!;
    expect(linea).not.toMatch(/[\n\t]/);
    expect(linea).toBe("2 empresas al corriente, sin hallazgos abiertos");
  });
});
