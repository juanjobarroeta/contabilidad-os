import { describe, it, expect } from "vitest";
import {
  formatCarteraDigest,
  formatCarteraDigestSummaryLine,
  formatCarteraDigestVariables,
  nombreCorto,
} from "./digest";

const HOY = new Date("2026-10-04T15:00:00Z"); // domingo 4-oct-2026, CDMX

describe("nombreCorto", () => {
  it("quita la forma societaria", () => {
    expect(nombreCorto("THE TRADING MARGIN S.A. DE C.V.")).toBe("THE TRADING MARGIN");
    expect(nombreCorto("AMA SAPI DE CV")).toBe("AMA");
    expect(nombreCorto("Grupo Norte, S. de R.L. de C.V.")).toBe("Grupo Norte");
    expect(nombreCorto("Despacho Ruiz S.C.")).toBe("Despacho Ruiz");
    expect(nombreCorto("JUAN PEREZ LOPEZ")).toBe("JUAN PEREZ LOPEZ");
  });
  it("recorta nombres largos", () => {
    const n = nombreCorto("COMERCIALIZADORA INTERNACIONAL DEL NORTE Y SUR");
    expect(n.length).toBeLessThanOrEqual(28);
    expect(n.endsWith("…")).toBe(true);
  });
});

describe("formatCarteraDigest (freeform completo)", () => {
  it("null sin empresas", () => {
    expect(formatCarteraDigest([])).toBeNull();
  });

  it("todo al corriente", () => {
    const txt = formatCarteraDigest([
      { razonSocial: "A", hallazgos: 0, criticos: 0 },
      { razonSocial: "B", hallazgos: 0, criticos: 0 },
    ], [], HOY)!;
    expect(txt).toContain("(2 empresas)");
    expect(txt).toContain("✅ Todas al corriente");
    expect(txt).not.toContain("Críticos");
  });

  it("agrupa por secciones y ordena por críticos", () => {
    const txt = formatCarteraDigest([
      { razonSocial: "Pocos", hallazgos: 1, criticos: 0 },
      { razonSocial: "Critica S.A. de C.V.", hallazgos: 3, criticos: 1 },
      { razonSocial: "MuyCritica", hallazgos: 4, criticos: 4 },
      { razonSocial: "Vencida", hallazgos: 0, criticos: 0, syncDetenida: "fiel_vencida" },
      { razonSocial: "Limpia", hallazgos: 0, criticos: 0 },
    ], [{ empresa: "Pocos", linea: "Falta el estado de cuenta." }], HOY)!;
    expect(txt).toContain("🔴 *Sin descarga del SAT*\n• Vencida: e.firma vencida");
    expect(txt).toContain("⚠️ *Críticos*\n• MuyCritica: 4 críticos\n• Critica: 1 crítico + 2 pendientes");
    expect(txt).toContain("🟡 *Pendientes*\n• Pocos: 1");
    expect(txt).toContain("📋 *Cierre guiado*\n• Pocos: Falta el estado de cuenta");
    expect(txt).toContain("✅ 1 al corriente");
    expect(txt).toMatch(/📅 Declaraciones de septiembre vencen el lunes 19 de octubre \(en 15 días\)/);
  });

  it("resume el excedente por sección", () => {
    const muchas = Array.from({ length: 10 }, (_, i) => ({ razonSocial: `E${i}`, hallazgos: 10 - i, criticos: 0 }));
    expect(formatCarteraDigest(muchas, [], HOY)).toContain("• y 4 más");
  });
});

describe("formatCarteraDigestSummaryLine (plantilla v1, una línea)", () => {
  it("null sin empresas", () => {
    expect(formatCarteraDigestSummaryLine([])).toBeNull();
  });

  it("agrupa por tipo, sin saltos, tabs ni punto final", () => {
    const linea = formatCarteraDigestSummaryLine([
      { razonSocial: "AMA S.A. DE C.V.", hallazgos: 9, criticos: 4 },
      { razonSocial: "THE TRADING MARGIN SA DE CV", hallazgos: 0, criticos: 0, syncDetenida: "fiel_vencida" },
      { razonSocial: "C", hallazgos: 2, criticos: 0 },
      { razonSocial: "D", hallazgos: 0, criticos: 0 },
    ], [{ empresa: "C", linea: "Falta el estado\nde cuenta." }], HOY)!;
    expect(linea).not.toMatch(/[\n\t]| {4}/);
    expect(linea).not.toMatch(/\.$/);
    expect(linea.startsWith("🔴 e.firma vencida: THE TRADING MARGIN · ⚠️ Críticos: AMA (4) · 🟡 Pendientes: C (2; falta el estado de cuenta) · ✅ 1 al corriente · 📅 declaraciones de septiembre vencen el lunes 19 de octubre (en 15 días)")).toBe(true);
  });

  it("omite bloques vacíos", () => {
    const linea = formatCarteraDigestSummaryLine([{ razonSocial: "A", hallazgos: 0, criticos: 0 }], [], HOY)!;
    expect(linea).toMatch(/^✅ 1 al corriente · 📅 declaraciones de septiembre vencen el lunes 19 de octubre \(en 15 días\)$/);
  });

  it("no rebasa el tope", () => {
    const muchas = Array.from({ length: 30 }, (_, k) => ({ razonSocial: `EMPRESA CON NOMBRE MUY LARGO ${k}`, hallazgos: 5, criticos: 2 }));
    const linea = formatCarteraDigestSummaryLine(muchas, [], HOY)!;
    expect(linea.length).toBeLessThanOrEqual(850);
    expect(linea).toContain("+26");
  });
});

describe("formatCarteraDigestVariables (plantilla v2)", () => {
  it("ninguna variable vacía ni multilínea", () => {
    const v = formatCarteraDigestVariables([{ razonSocial: "A", hallazgos: 0, criticos: 0 }], [], HOY)!;
    expect(v).toMatchObject({ sat: "ninguno", criticos: "ninguno", pendientes: "ninguno", alCorriente: "1" });
    for (const x of Object.values(v)) expect(x).not.toMatch(/^$|[\n\t]/);
  });
  it("motivos mixtos van por empresa", () => {
    const v = formatCarteraDigestVariables([
      { razonSocial: "A", hallazgos: 0, criticos: 0, syncDetenida: "fiel_vencida" },
      { razonSocial: "B", hallazgos: 0, criticos: 0, syncDetenida: "fiel_revocada" },
    ], [], HOY)!;
    expect(v.sat).toBe("A (e.firma vencida), B (e.firma revocada)");
  });
});
