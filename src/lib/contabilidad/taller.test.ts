import { describe, it, expect } from "vitest";
import {
  costoCompraRefacciones,
  cuentaPorNombre,
  resolverCuentasTaller,
  repartoTaller,
  type ContextoTaller,
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
  { id: "h", cuentaSAT: "5401-0001-0000", nombre: "COSTO REFACCIONES" },
  { id: "i", cuentaSAT: "5401-0009-0000", nombre: "COSTO REFACCIONES TALLER" },
  { id: "j", cuentaSAT: "5401-0013-0000", nombre: "COSTO REFACCIONES TALLER GARANTIAS" },
  { id: "k", cuentaSAT: "5401-0015-0000", nombre: "RECUPERACION SERV INTERNOS" },
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

describe("costoCompraRefacciones() — fase 2f", () => {
  const ctas = resolverCuentasTaller(CATALOGO);
  const ctx = (compras: [string, number][]): ContextoTaller => ({
    ctas, servicios: new Map(), refacciones: new Set(), comprasRefaccion: new Map(compras),
  });

  it("las cuentas de costo salen del catálogo por nombre, como las de venta", () => {
    expect(ctas.costoRefaccionesTaller?.cuentaSAT).toBe("5401-0009-0000");
    expect(ctas.costoRefaccionesMostrador?.cuentaSAT).toBe("5401-0001-0000");
  });

  it("reparte la compra con la mezcla de venta del período", () => {
    const p = costoCompraRefacciones("c1", 10000, { taller: 800, mostrador: 200 }, ctx([["c1", 10000]]))!;
    expect(p.map((x) => [x.cuenta.cuentaSAT, x.monto])).toEqual([
      ["5401-0009-0000", 8000],
      ["5401-0001-0000", 2000],
    ]);
  });

  it("nunca carga más de lo que dice el comprobante", () => {
    const p = costoCompraRefacciones("c2", 500, { taller: 1, mostrador: 0 }, ctx([["c2", 900]]))!;
    expect(p.reduce((a, x) => a + x.monto, 0)).toBe(500);
  });

  it("sin ventas de refacción en el período, la compra es de taller", () => {
    const p = costoCompraRefacciones("c3", 300, { taller: 0, mostrador: 0 }, ctx([["c3", 300]]))!;
    expect(p).toHaveLength(1);
    expect(p[0].cuenta.cuentaSAT).toBe("5401-0009-0000");
  });

  it("un CFDI sin entrada de almacén no es costo de refacción", () => {
    expect(costoCompraRefacciones("otro", 1000, { taller: 1, mostrador: 1 }, ctx([["c4", 10]]))).toBeNull();
  });

  it("las piernas suman exactamente el importe repartido", () => {
    const p = costoCompraRefacciones("c5", 1000.01, { taller: 1, mostrador: 2 }, ctx([["c5", 1000.01]]))!;
    expect(p.reduce((a, x) => a + x.monto, 0)).toBeCloseTo(1000.01, 2);
  });
});
