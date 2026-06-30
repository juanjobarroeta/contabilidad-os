import { describe, it, expect } from "vitest";
import {
  nominaVenceManana,
  cadenciaDesdeCodigoSat,
  inferirCadenciaDesdeEmpleados,
  inferirCadenciaDesdeRuns,
  CADENCIA_LABEL,
} from "./recordatorio";

// Helper: fecha local sin hora (los tests sólo dependen del día).
const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);

describe("nominaVenceManana — SEMANAL (paga viernes, recuerda jueves)", () => {
  it("avisa el jueves (mañana = viernes)", () => {
    // 2026-07-02 es jueves → mañana 2026-07-03 viernes.
    const r = nominaVenceManana("SEMANAL", d(2026, 7, 2));
    expect(r.vence).toBe(true);
    expect(r.motivo).toBe("viernes");
    expect(r.fechaPago?.getDay()).toBe(5);
    expect(r.fechaPago?.getDate()).toBe(3);
  });

  it("NO avisa otros días (miércoles → mañana jueves)", () => {
    expect(nominaVenceManana("SEMANAL", d(2026, 7, 1)).vence).toBe(false);
  });

  it("NO avisa el viernes (mañana sábado)", () => {
    expect(nominaVenceManana("SEMANAL", d(2026, 7, 3)).vence).toBe(false);
  });
});

describe("nominaVenceManana — QUINCENAL (15 y fin de mes)", () => {
  it("avisa el 14 (mañana = día 15)", () => {
    const r = nominaVenceManana("QUINCENAL", d(2026, 7, 14));
    expect(r.vence).toBe(true);
    expect(r.motivo).toBe("día 15");
    expect(r.fechaPago?.getDate()).toBe(15);
  });

  it("avisa la víspera del fin de mes (30 jun → mañana 30? no: 29→30 en jun)", () => {
    // Junio tiene 30 días: el 29 → mañana 30 = fin de mes.
    const r = nominaVenceManana("QUINCENAL", d(2026, 6, 29));
    expect(r.vence).toBe(true);
    expect(r.motivo).toBe("fin de mes");
    expect(r.fechaPago?.getDate()).toBe(30);
  });

  it("avisa la víspera del fin de mes en julio (30 → mañana 31)", () => {
    const r = nominaVenceManana("QUINCENAL", d(2026, 7, 30));
    expect(r.vence).toBe(true);
    expect(r.motivo).toBe("fin de mes");
    expect(r.fechaPago?.getDate()).toBe(31);
  });

  it("avisa la víspera del fin de febrero (28 feb 2026 = 27→28)", () => {
    const r = nominaVenceManana("QUINCENAL", d(2026, 2, 27));
    expect(r.vence).toBe(true);
    expect(r.motivo).toBe("fin de mes");
    expect(r.fechaPago?.getDate()).toBe(28);
  });

  it("NO avisa el 13 (mañana día 14)", () => {
    expect(nominaVenceManana("QUINCENAL", d(2026, 7, 13)).vence).toBe(false);
  });

  it("NO avisa el 15 (mañana día 16)", () => {
    expect(nominaVenceManana("QUINCENAL", d(2026, 7, 15)).vence).toBe(false);
  });
});

describe("nominaVenceManana — MENSUAL (fin de mes)", () => {
  it("avisa la víspera del fin de mes (30 → mañana 31)", () => {
    const r = nominaVenceManana("MENSUAL", d(2026, 7, 30));
    expect(r.vence).toBe(true);
    expect(r.motivo).toBe("fin de mes");
    expect(r.fechaPago?.getDate()).toBe(31);
  });

  it("NO avisa el 14 (no es víspera de fin de mes)", () => {
    expect(nominaVenceManana("MENSUAL", d(2026, 7, 14)).vence).toBe(false);
  });

  it("NO avisa el último día (mañana = día 1 del mes siguiente)", () => {
    expect(nominaVenceManana("MENSUAL", d(2026, 7, 31)).vence).toBe(false);
  });
});

describe("cruce de mes/año en 'mañana'", () => {
  it("31 dic → mañana 1 ene: ninguna cadencia avisa", () => {
    expect(nominaVenceManana("MENSUAL", d(2026, 12, 31)).vence).toBe(false);
    expect(nominaVenceManana("QUINCENAL", d(2026, 12, 31)).vence).toBe(false);
  });

  it("QUINCENAL: 30 dic → mañana 31 dic = fin de mes", () => {
    const r = nominaVenceManana("QUINCENAL", d(2026, 12, 30));
    expect(r.vence).toBe(true);
    expect(r.fechaPago?.getMonth()).toBe(11); // diciembre
  });
});

describe("etiquetas", () => {
  it("expone label humano por cadencia", () => {
    expect(CADENCIA_LABEL.SEMANAL).toBe("semanal");
    expect(CADENCIA_LABEL.QUINCENAL).toBe("quincenal");
    expect(CADENCIA_LABEL.MENSUAL).toBe("mensual");
  });
});

describe("cadenciaDesdeCodigoSat", () => {
  it("mapea códigos SAT a cadencia", () => {
    expect(cadenciaDesdeCodigoSat("02")).toBe("SEMANAL");
    expect(cadenciaDesdeCodigoSat("03")).toBe("SEMANAL");
    expect(cadenciaDesdeCodigoSat("04")).toBe("QUINCENAL");
    expect(cadenciaDesdeCodigoSat("05")).toBe("MENSUAL");
    expect(cadenciaDesdeCodigoSat("06")).toBe("MENSUAL");
  });
  it("devuelve null para desconocidos/vacíos", () => {
    expect(cadenciaDesdeCodigoSat("99")).toBeNull();
    expect(cadenciaDesdeCodigoSat(null)).toBeNull();
    expect(cadenciaDesdeCodigoSat(undefined)).toBeNull();
  });
});

describe("inferirCadenciaDesdeEmpleados", () => {
  it("toma la moda de las periodicidades", () => {
    expect(inferirCadenciaDesdeEmpleados(["04", "04", "05"])).toBe("QUINCENAL");
    expect(inferirCadenciaDesdeEmpleados(["02", "02", "04"])).toBe("SEMANAL");
  });
  it("null si no hay señal", () => {
    expect(inferirCadenciaDesdeEmpleados([])).toBeNull();
    expect(inferirCadenciaDesdeEmpleados(["99", null])).toBeNull();
  });
});

describe("inferirCadenciaDesdeRuns", () => {
  it("clasifica por duración del periodo", () => {
    expect(inferirCadenciaDesdeRuns([7, 7, 15])).toBe("SEMANAL");
    expect(inferirCadenciaDesdeRuns([15, 15, 30])).toBe("QUINCENAL");
    expect(inferirCadenciaDesdeRuns([30, 31, 30])).toBe("MENSUAL");
  });
  it("ignora duraciones inválidas y devuelve null sin datos", () => {
    expect(inferirCadenciaDesdeRuns([0, -3, NaN])).toBeNull();
    expect(inferirCadenciaDesdeRuns([])).toBeNull();
  });
});
