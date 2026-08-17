import { describe, it, expect } from "vitest";
import {
  indexarCuentasFamilia,
  cuentaDeFamilia,
  MOTOR_VENTAS_UNIDAD,
  MOTOR_COSTO_UNIDAD,
  MOTOR_INVENTARIO_UNIDAD,
  type CuentaFamilia,
} from "./resolver-familia";

// La estructura real de MARGOM: mismo sufijo de familia en las tres series
// (4101-00XX venta, 5101-00XX costo, 1301-00XX inventario), cada serie bajo su
// agrupador (401.01 / 501.01 / 115.04). La familia desambigua lo que la
// inversión de Fase 1 no puede.

const cta = (cuentaSAT: string, codAgrup: string | null, tipo = "ACTIVO"): CuentaFamilia => ({
  id: cuentaSAT,
  cuentaSAT,
  subcuenta: null,
  nombre: `CUENTA ${cuentaSAT}`,
  tipo,
  codAgrup,
});

describe("indexarCuentasFamilia() / cuentaDeFamilia()", () => {
  it("el mismo sufijo resuelve en las tres series", () => {
    const idx = indexarCuentasFamilia([
      cta("1301-0004-0000", "115.04"),
      cta("4101-0004-0000", "401.01", "INGRESO"),
      cta("5101-0004-0000", "501.01", "COSTO"),
    ]);
    expect(cuentaDeFamilia(idx, MOTOR_INVENTARIO_UNIDAD, "0004")?.cuentaSAT).toBe("1301-0004-0000");
    expect(cuentaDeFamilia(idx, MOTOR_VENTAS_UNIDAD, "0004")?.cuentaSAT).toBe("4101-0004-0000");
    expect(cuentaDeFamilia(idx, MOTOR_COSTO_UNIDAD, "0004")?.cuentaSAT).toBe("5101-0004-0000");
  });

  it("sufijo duplicado bajo el mismo agrupador → ambiguo → null", () => {
    const idx = indexarCuentasFamilia([
      cta("1301-0004-0000", "115.04"),
      cta("1312-0004-0000", "115.04"), // usados comparten agrupador Y sufijo
    ]);
    expect(cuentaDeFamilia(idx, MOTOR_INVENTARIO_UNIDAD, "0004")).toBeNull();
  });

  it("familias distintas del mismo agrupador NO se estorban", () => {
    const idx = indexarCuentasFamilia([
      cta("1301-0004-0000", "115.04"),
      cta("1301-0013-0000", "115.04"),
    ]);
    expect(cuentaDeFamilia(idx, MOTOR_INVENTARIO_UNIDAD, "0013")?.cuentaSAT).toBe("1301-0013-0000");
  });

  it("cuenta sin codAgrup o sin patrón de familia se ignora", () => {
    const idx = indexarCuentasFamilia([
      cta("1301-0029-0000", null), // el CT no la declara
      cta("115.04", "115.04"), // stub agrupador, no numeración propia
    ]);
    expect(idx.size).toBe(0);
  });

  it("familia inexistente → null (fallback del motor)", () => {
    const idx = indexarCuentasFamilia([cta("1301-0004-0000", "115.04")]);
    expect(cuentaDeFamilia(idx, MOTOR_INVENTARIO_UNIDAD, "0099")).toBeNull();
  });
});
