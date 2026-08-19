import { describe, it, expect } from "vitest";
import {
  cuentaPorNombre,
  resolverCuentasTaller,
  repartoTaller,
  type CuentaTaller,
} from "./taller";

// El catálogo real de MARGOM, recortado a las series del taller.
const CATALOGO: CuentaTaller[] = [
  { id: "a", cuentaSAT: "4301-0001-0000", nombre: "VENTA MANO DE OBRA SERVICIO" },
  { id: "b", cuentaSAT: "4301-0002-0000", nombre: "VENTA MANO DE OBRA H y P" },
  { id: "c", cuentaSAT: "4301-0003-0000", nombre: "VENTA MANO DE OBRA GARANTIAS" },
  { id: "d", cuentaSAT: "4401-0001-0000", nombre: "VENTA REFACCIONES" },
  { id: "e", cuentaSAT: "4401-0009-0000", nombre: "VENTA REFACCIONES TALLER" },
  { id: "f", cuentaSAT: "4401-0010-0000", nombre: "VENTA ACCESORIOS TALLER" },
  { id: "g", cuentaSAT: "4401-0013-0000", nombre: "VENTA REFACCIONES TALLER GARANTIAS" },
];

describe("cuentaPorNombre()", () => {
  it("desempata por nombre dentro de la serie", () => {
    expect(cuentaPorNombre(CATALOGO, "4401", ["REFACCIONES", "TALLER"], ["GARANTIA", "ACCESORIOS"])?.cuentaSAT)
      .toBe("4401-0009-0000");
  });

  it("dos candidatas → null: no se adivina subcuenta", () => {
    expect(cuentaPorNombre(CATALOGO, "4301", ["MANO DE OBRA"], [])).toBeNull();
  });

  it("ninguna candidata → null", () => {
    expect(cuentaPorNombre(CATALOGO, "4501", ["SEGUROS"], [])).toBeNull();
  });
});

describe("resolverCuentasTaller()", () => {
  it("saca las tres cuentas del catálogo del contador", () => {
    const c = resolverCuentasTaller(CATALOGO);
    expect(c.manoObra?.cuentaSAT).toBe("4301-0001-0000");
    expect(c.refaccionesTaller?.cuentaSAT).toBe("4401-0009-0000");
    expect(c.refaccionesMostrador?.cuentaSAT).toBe("4401-0001-0000");
  });

  it("catálogo sin las series → todo null, el motor no cambia de conducta", () => {
    const c = resolverCuentasTaller([{ id: "x", cuentaSAT: "4101-0001-0000", nombre: "VENTA NUEVOS J7" }]);
    expect(c.manoObra).toBeNull();
    expect(c.refaccionesTaller).toBeNull();
    expect(c.refaccionesMostrador).toBeNull();
  });
});

describe("repartoTaller()", () => {
  const ctas = resolverCuentasTaller(CATALOGO);

  it("parte la orden en la proporción del DMS y suma el subtotal exacto", () => {
    const piernas = repartoTaller(10000, { manoObra: 300, refacciones: 700 }, true, ctas)!;
    expect(piernas.map((p) => [p.cuenta.cuentaSAT, p.monto])).toEqual([
      ["4301-0001-0000", 3000],
      ["4401-0009-0000", 7000],
    ]);
    expect(piernas.reduce((a, p) => a + p.monto, 0)).toBe(10000);
  });

  it("el corte del DMS es proporción, no importe: escala al subtotal del CFDI", () => {
    // La orden trae $1,000 partidos mitad y mitad, pero el CFDI factura $3,000.
    const piernas = repartoTaller(3000, { manoObra: 500, refacciones: 500 }, true, ctas)!;
    expect(piernas.map((p) => p.monto)).toEqual([1500, 1500]);
  });

  it("orden sin corte → toda a mano de obra", () => {
    const piernas = repartoTaller(2500, { manoObra: 0, refacciones: 0 }, false, ctas)!;
    expect(piernas).toHaveLength(1);
    expect(piernas[0].cuenta.cuentaSAT).toBe("4301-0001-0000");
    expect(piernas[0].monto).toBe(2500);
  });

  it("refacciones sin orden → mostrador, no taller", () => {
    const piernas = repartoTaller(800, undefined, true, ctas)!;
    expect(piernas[0].cuenta.cuentaSAT).toBe("4401-0001-0000");
  });

  it("el redondeo no se pierde: las piernas suman el subtotal al centavo", () => {
    const piernas = repartoTaller(1000.01, { manoObra: 1, refacciones: 2 }, true, ctas)!;
    expect(piernas.reduce((a, p) => a + p.monto, 0)).toBeCloseTo(1000.01, 2);
  });

  it("sin señal de taller → null (venta de unidad, gasto, lo que sea)", () => {
    expect(repartoTaller(5000, undefined, false, ctas)).toBeNull();
  });

  it("falta la cuenta destino → null, cae al fallback y no se inventa nada", () => {
    const sinRefa = { ...ctas, refaccionesTaller: null };
    expect(repartoTaller(1000, { manoObra: 1, refacciones: 1 }, true, sinRefa)).toBeNull();
  });
});
