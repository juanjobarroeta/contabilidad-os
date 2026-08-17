import { describe, it, expect } from "vitest";
import {
  indexarCuentasFamilia,
  cuentaDeFamilia,
  MOTOR_VENTAS_UNIDAD,
  MOTOR_COSTO_UNIDAD,
  MOTOR_INVENTARIO_UNIDAD,
  type CuentaFamilia,
} from "./resolver-familia";

// La estructura real de MARGOM: la familia se repite en VARIAS series bajo el
// MISMO agrupador — 4101 nuevos / 4111 demo / 4131 intercambio / 4141 flotilla
// (todas 401.01) y 1312 usados junto a 1301 (ambas 115.04). Indexar por
// (agrupador:sufijo) hacía ambigua TODA venta: cero resoluciones a 4101 y cero
// costos de venta en 23 períodos re-posteados, medido en producción. La llave
// correcta es (agrupador:serie:sufijo), y el flujo de unidades NUEVAS apunta a
// la serie base 4101/5101/1301.

const cta = (cuentaSAT: string, codAgrup: string | null, tipo = "ACTIVO"): CuentaFamilia => ({
  id: cuentaSAT,
  cuentaSAT,
  subcuenta: null,
  nombre: `CUENTA ${cuentaSAT}`,
  tipo,
  codAgrup,
});

// El plan de FRISON tal como existe en MARGOM: 14 cuentas del sufijo 0004.
const PLAN_FRISON = [
  cta("1301-0004-0000", "115.04"),
  cta("1312-0004-0000", "115.04"), // usados no afectos — misma familia, misma 115.04
  cta("4101-0004-0000", "401.01", "INGRESO"),
  cta("4111-0004-0000", "401.01", "INGRESO"), // demo
  cta("4131-0004-0000", "401.01", "INGRESO"), // intercambio
  cta("4141-0004-0000", "401.01", "INGRESO"), // flotilla
  cta("5101-0004-0000", "501.01", "COSTO"),
  cta("5111-0004-0000", "501.01", "COSTO"),
  cta("5131-0004-0000", "501.01", "COSTO"),
  cta("5141-0004-0000", "501.01", "COSTO"),
];

describe("indexarCuentasFamilia() / cuentaDeFamilia()", () => {
  it("las series hermanas del contador NO bloquean la serie base (el caso que costó $1.7B sin costo de venta)", () => {
    const idx = indexarCuentasFamilia(PLAN_FRISON);
    expect(cuentaDeFamilia(idx, MOTOR_VENTAS_UNIDAD, "0004")?.cuentaSAT).toBe("4101-0004-0000");
    expect(cuentaDeFamilia(idx, MOTOR_COSTO_UNIDAD, "0004")?.cuentaSAT).toBe("5101-0004-0000");
    expect(cuentaDeFamilia(idx, MOTOR_INVENTARIO_UNIDAD, "0004")?.cuentaSAT).toBe("1301-0004-0000");
  });

  it("1312 (usados) ya no hace ambiguo el inventario de nuevos de la familia", () => {
    const idx = indexarCuentasFamilia([
      cta("1301-0004-0000", "115.04"),
      cta("1312-0004-0000", "115.04"),
    ]);
    expect(cuentaDeFamilia(idx, MOTOR_INVENTARIO_UNIDAD, "0004")?.cuentaSAT).toBe("1301-0004-0000");
  });

  it("una llave (agrupador:serie:sufijo) genuinamente repetida sigue siendo ambigua → null", () => {
    const idx = indexarCuentasFamilia([
      cta("1301-0004-0000", "115.04"),
      cta("1301-0004-0001", "115.04"), // dos activas de la MISMA serie y sufijo
    ]);
    expect(cuentaDeFamilia(idx, MOTOR_INVENTARIO_UNIDAD, "0004")).toBeNull();
  });

  it("la serie correcta con el agrupador equivocado no resuelve", () => {
    // 4101 declarada bajo otro agrupador: el número se parece pero el CT no la
    // declara donde el motor postea — no es candidata.
    const idx = indexarCuentasFamilia([cta("4101-0004-0000", "403.01", "INGRESO")]);
    expect(cuentaDeFamilia(idx, MOTOR_VENTAS_UNIDAD, "0004")).toBeNull();
  });

  it("familias distintas de la misma serie no se estorban", () => {
    const idx = indexarCuentasFamilia([
      cta("1301-0004-0000", "115.04"),
      cta("1301-0013-0000", "115.04"),
    ]);
    expect(cuentaDeFamilia(idx, MOTOR_INVENTARIO_UNIDAD, "0013")?.cuentaSAT).toBe("1301-0013-0000");
  });

  it("cuenta sin codAgrup o sin patrón serie-sufijo se ignora", () => {
    const idx = indexarCuentasFamilia([
      cta("1301-0029-0000", null),
      cta("115.04", "115.04"), // stub agrupador, no numeración propia
    ]);
    expect(idx.size).toBe(0);
  });

  it("familia inexistente → null (fallback del motor)", () => {
    const idx = indexarCuentasFamilia(PLAN_FRISON);
    expect(cuentaDeFamilia(idx, MOTOR_INVENTARIO_UNIDAD, "0099")).toBeNull();
  });
});
