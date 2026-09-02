import { describe, it, expect } from "vitest";
import {
  factorInpc,
  perdidaVigente,
  primeraActualizacion,
  perdidasDisponibles,
  aplicarPerdidas,
  ANIOS_AMORTIZACION,
  type PerdidaRecord,
} from "./perdidas";

describe("factorInpc()", () => {
  it("computes the INPC ratio to 4 decimals when both months are loaded", () => {
    // dic-2023 (132.373) → jun-2025 (140.405) — verificado vs Banxico SP1
    expect(factorInpc({ year: 2023, month: 12 }, { year: 2025, month: 6 })).toEqual({
      factor: 1.0607,
      completo: true,
    });
  });

  it("falls back to nominal (1, completo false) when an INPC is missing", () => {
    expect(factorInpc({ year: 2023, month: 12 }, { year: 2026, month: 8 })).toEqual({
      factor: 1,
      completo: false,
    });
  });
});

describe("perdidaVigente() — ventana de 10 ejercicios (Art. 57)", () => {
  it("es vigente dentro de los 10 ejercicios posteriores al origen", () => {
    expect(perdidaVigente({ ejercicioOrigen: 2015 }, 2016)).toBe(true);
    expect(perdidaVigente({ ejercicioOrigen: 2015 }, 2015 + ANIOS_AMORTIZACION)).toBe(true); // 2025, frontera
  });

  it("no es vigente en el año de origen ni tras expirar", () => {
    expect(perdidaVigente({ ejercicioOrigen: 2015 }, 2015)).toBe(false);
    expect(perdidaVigente({ ejercicioOrigen: 2015 }, 2015 + ANIOS_AMORTIZACION + 1)).toBe(false); // 2026
  });
});

describe("primeraActualizacion() — jul→dic del ejercicio de origen", () => {
  it("actualiza la pérdida del 2023 por el factor dic/jul", () => {
    const r = primeraActualizacion(100_000, 2023);
    expect(r.mesUltimaActualizacion).toBe("2023-12");
    expect(r.factor).toBe(1.0275); // 132.373 / 128.832
    expect(r.saldoActualizado).toBe(102_750);
    expect(r.completo).toBe(true);
  });
});

// Para aislar la lógica FIFO/cap/expiración de la aritmética del INPC, los saldos
// ya están actualizados a junio del ejercicio de aplicación → factor = 1 exacto.
const recAt = (ejercicioOrigen: number, saldo: number, mes: string): PerdidaRecord => ({
  ejercicioOrigen,
  montoOriginal: saldo,
  saldoActualizado: saldo,
  mesUltimaActualizacion: mes,
  agotada: false,
});

describe("perdidasDisponibles()", () => {
  it("suma los saldos vigentes actualizados a junio del ejercicio", () => {
    const recs = [recAt(2021, 50_000, "2024-06"), recAt(2022, 30_000, "2024-06")];
    const r = perdidasDisponibles(recs, 2024);
    expect(r.total).toBe(80_000);
    expect(r.algunaIncompleta).toBe(false);
    expect(r.detalles.map((d) => d.ejercicioOrigen)).toEqual([2021, 2022]); // FIFO
    expect(r.detalles[0].mesActualizado).toBe("2024-06");
  });

  it("excluye pérdidas agotadas, sin saldo o ya expiradas", () => {
    const recs: PerdidaRecord[] = [
      { ...recAt(2021, 50_000, "2024-06"), agotada: true },
      recAt(2022, 0, "2024-06"),
      recAt(2013, 99_000, "2024-06"), // 2013+10 = 2023 < 2024 → expirada
    ];
    expect(perdidasDisponibles(recs, 2024).total).toBe(0);
  });
});

describe("aplicarPerdidas() — FIFO contra la utilidad", () => {
  it("amortiza las más antiguas primero y agota la utilidad", () => {
    const recs = [recAt(2021, 50_000, "2024-06"), recAt(2022, 30_000, "2024-06")];
    const r = aplicarPerdidas(recs, 60_000, 2024);

    expect(r.totalDisponible).toBe(80_000);
    expect(r.totalAplicado).toBe(60_000);

    // 2021 se agota (50k), 2022 aporta 10k → queda 20k.
    const a = r.detalles.find((d) => d.ejercicioOrigen === 2021)!;
    const b = r.detalles.find((d) => d.ejercicioOrigen === 2022)!;
    expect(a.aplicado).toBe(50_000);
    expect(a.saldoRestante).toBe(0);
    expect(b.aplicado).toBe(10_000);
    expect(b.saldoRestante).toBe(20_000);

    const nb = r.saldosNuevos.find((s) => s.ejercicioOrigen === 2022)!;
    expect(nb).toMatchObject({ saldoActualizado: 20_000, agotada: false, ultimoEjercicioAplicado: 2024 });
    expect(r.saldosNuevos.find((s) => s.ejercicioOrigen === 2021)!.agotada).toBe(true);
  });

  it("no aplica nada cuando no hay utilidad (año en pérdida)", () => {
    const recs = [recAt(2022, 30_000, "2024-06")];
    const r = aplicarPerdidas(recs, 0, 2024);
    expect(r.totalAplicado).toBe(0);
    expect(r.detalles[0].saldoRestante).toBe(30_000);
  });

  it("marca actualización incompleta cuando falta el INPC (cae a nominal)", () => {
    // dic-2023 → jun-2026 (no cargado) ⇒ factor 1, completo false
    // Aplicación en 2027: su junio (mes de aplicación, Art. 57) aún no puede
    // estar cargado — antes se usaba 2026 y el test caducó al cargar jun-2026.
    const recs = [recAt(2023, 40_000, "2023-12")];
    const r = aplicarPerdidas(recs, 100_000, 2027);
    expect(r.algunaIncompleta).toBe(true);
    expect(r.totalDisponible).toBe(40_000); // ×1 nominal
    expect(r.totalAplicado).toBe(40_000);
  });
});
