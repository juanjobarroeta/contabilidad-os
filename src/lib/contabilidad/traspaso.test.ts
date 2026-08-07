import { describe, it, expect } from "vitest";
import { construirTraspaso, referenciaTraspaso } from "./traspaso";

const RESULTADO = "acc-305";   // 305.01 Utilidad del ejercicio
const ACUMULADOS = "acc-304";  // 304.01 Utilidad de ejercicios anteriores

describe("construirTraspaso", () => {
  it("una utilidad vacía 305.01 con CARGO y acumula en 304.01 con ABONO", () => {
    const t = construirTraspaso(120_000, RESULTADO, ACUMULADOS);
    expect(t.resultado).toBe(120_000);
    expect(t.entries).toEqual([
      { chartAccountId: RESULTADO, tipo: "CARGO", monto: 120_000 },
      { chartAccountId: ACUMULADOS, tipo: "ABONO", monto: 120_000 },
    ]);
  });

  it("una pérdida hace el asiento inverso", () => {
    const t = construirTraspaso(-45_500, RESULTADO, ACUMULADOS);
    expect(t.resultado).toBe(-45_500);
    expect(t.entries).toEqual([
      { chartAccountId: RESULTADO, tipo: "ABONO", monto: 45_500 },
      { chartAccountId: ACUMULADOS, tipo: "CARGO", monto: 45_500 },
    ]);
  });

  it("siempre cuadra: un solo cargo y un solo abono por el mismo importe", () => {
    for (const saldo of [98_765.43, -1_234.56, 0.01, -0.01]) {
      const { entries } = construirTraspaso(saldo, RESULTADO, ACUMULADOS);
      const cargos = entries.filter((e) => e.tipo === "CARGO").reduce((s, e) => s + e.monto, 0);
      const abonos = entries.filter((e) => e.tipo === "ABONO").reduce((s, e) => s + e.monto, 0);
      expect(cargos).toBe(abonos);
      expect(entries).toHaveLength(2);
    }
  });

  it("un ejercicio en ceros no genera asiento", () => {
    expect(construirTraspaso(0, RESULTADO, ACUMULADOS)).toEqual({ entries: [], resultado: 0 });
    // Ruido de centavos por debajo del medio centavo tampoco.
    expect(construirTraspaso(0.004, RESULTADO, ACUMULADOS).entries).toHaveLength(0);
    expect(construirTraspaso(-0.004, RESULTADO, ACUMULADOS).entries).toHaveLength(0);
  });

  it("redondea a centavos", () => {
    const t = construirTraspaso(1000.005, RESULTADO, ACUMULADOS);
    expect(t.entries[0].monto).toBe(1000.01);
    expect(t.entries[1].monto).toBe(1000.01);
  });

  it("nunca se traspasa una cuenta contra sí misma", () => {
    const t = construirTraspaso(500, RESULTADO, ACUMULADOS);
    expect(t.entries[0].chartAccountId).not.toBe(t.entries[1].chartAccountId);
  });
});

describe("referenciaTraspaso", () => {
  it("es estable por ejercicio (idempotencia del regenerado)", () => {
    expect(referenciaTraspaso(2025)).toBe("traspaso-2025");
    expect(referenciaTraspaso(2025)).toBe(referenciaTraspaso(2025));
    expect(referenciaTraspaso(2026)).not.toBe(referenciaTraspaso(2025));
  });
});
