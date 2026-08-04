import { describe, it, expect } from "vitest";
import {
  calcularDepreciacionMes,
  depreciacionDelMes,
  acumuladaContableHasta,
  type ActivoParaDepreciar,
} from "./depreciacion-contable";

const computo = (over: Partial<ActivoParaDepreciar> = {}): ActivoParaDepreciar => ({
  id: "act1",
  descripcion: "Laptop",
  tipo: "computo", // 30% anual
  moi: 36000,
  fechaInicioUso: new Date("2026-03-15T12:00:00Z"),
  tasaAnual: null,
  fechaBaja: null,
  ...over,
});

describe("depreciacionDelMes", () => {
  it("mes completo: MOI × tasa / 12 (36,000 × 30% / 12 = 900)", () => {
    expect(depreciacionDelMes(computo(), 2026, 4)).toBe(900);
  });

  it("antes del inicio de uso: 0; el mes de inicio cuenta completo (Art. 31)", () => {
    expect(depreciacionDelMes(computo(), 2026, 2)).toBe(0);
    expect(depreciacionDelMes(computo(), 2026, 3)).toBe(900);
  });

  it("respeta la tasa capturada en la ficha (tasaAnual)", () => {
    expect(depreciacionDelMes(computo({ tasaAnual: 0.12 }), 2026, 4)).toBe(360); // 36,000×12%/12
  });

  it("se detiene al agotar el MOI (saldo topado)", () => {
    // 30% de 36,000 = 10,800/año → se agota en 40 meses: mar-2026 + 39 → jun-2029.
    const a = computo();
    expect(depreciacionDelMes(a, 2029, 6)).toBe(900); // mes 40, último
    expect(depreciacionDelMes(a, 2029, 7)).toBe(0); // agotado
    expect(acumuladaContableHasta(a, 2029, 6)).toBe(36000);
  });

  it("contable NO aplica tope de automóvil (eso es fiscal)", () => {
    const auto = computo({ tipo: "transporte", moi: 600000 }); // 25%
    // 600,000 × 25% / 12 = 12,500 — sin tope de 175k.
    expect(depreciacionDelMes(auto, 2026, 5)).toBe(12500);
  });
});

describe("calcularDepreciacionMes", () => {
  it("genera el cargo/abono del mes con las cuentas oficiales por tipo", () => {
    const { mensuales, bajas } = calcularDepreciacionMes([computo()], 2026, 4);
    expect(bajas).toHaveLength(0);
    expect(mensuales).toHaveLength(1);
    expect(mensuales[0]).toMatchObject({
      monto: 900,
      cuentaGasto: "601.84",
      cuentaAcumulada: "171.05", // equipo de cómputo
    });
  });

  it("baja del mes: cancela MOI y acumulada, manda valor en libros a 703.xx", () => {
    const a = computo({ fechaBaja: new Date("2026-08-10T12:00:00Z") });
    const { mensuales, bajas } = calcularDepreciacionMes([a], 2026, 8);
    // Al dar de baja se deprecia hasta el mes ANTERIOR (jul): mar→jul = 5 meses × 900 = 4,500.
    expect(mensuales).toHaveLength(0);
    expect(bajas).toHaveLength(1);
    expect(bajas[0]).toMatchObject({
      moi: 36000,
      acumuladaALaBaja: 4500,
      valorEnLibros: 31500,
      cuentaActivo: "156.01",
      cuentaAcumulada: "171.05",
      cuentaPerdida: "703.06",
    });
  });

  it("activo sin uso todavía no genera nada", () => {
    const { mensuales } = calcularDepreciacionMes(
      [computo({ fechaInicioUso: new Date("2026-09-01T12:00:00Z") })],
      2026,
      4
    );
    expect(mensuales).toHaveLength(0);
  });
});
