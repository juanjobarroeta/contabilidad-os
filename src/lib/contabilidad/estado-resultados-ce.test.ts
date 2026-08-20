import { describe, it, expect } from "vitest";
import { construirEstadoResultados, rubroDeCuenta, type MovimientoCuenta } from "./estado-resultados-ce";

describe("rubroDeCuenta()", () => {
  it("clasifica por el primer dígito del número de cuenta", () => {
    expect(rubroDeCuenta("4101-0001-0000")).toBe("ingresos");
    expect(rubroDeCuenta("5131-0002-0000")).toBe("costos");
    expect(rubroDeCuenta("6300-1024-0000")).toBe("gastos");
    expect(rubroDeCuenta("7101-0001-0000")).toBe("financieros");
  });

  it("las cuentas de balance no entran al estado de resultados", () => {
    expect(rubroDeCuenta("1301-0004-0000")).toBeNull();
    expect(rubroDeCuenta("2002-0001-0000")).toBeNull();
  });
});

describe("construirEstadoResultados()", () => {
  // Cifras de MARGOM 2025 redondeadas a millones, con su signo natural.
  const declarado: MovimientoCuenta[] = [
    { numCta: "4101-0001-0000", nombre: "VENTA NUEVOS J7", monto: 1297 },
    { numCta: "4131-0001-0000", nombre: "VENTA J7 INTERCAMBIO", monto: 713 },
    { numCta: "5101-0001-0000", nombre: "COSTO NUEVOS J7", monto: -1138 },
    { numCta: "5131-0001-0000", nombre: "COSTO J7 INTERCAMBIO", monto: -714 },
    { numCta: "6300-1024-0000", nombre: "COMBUSTIBLES", monto: -170 },
  ];
  const derivado: MovimientoCuenta[] = [
    { numCta: "4101-0001-0000", nombre: "VENTA NUEVOS J7", monto: 1330 },
    { numCta: "4131-0001-0000", nombre: "VENTA J7 INTERCAMBIO", monto: 730 },
    { numCta: "5101-0001-0000", nombre: "COSTO NUEVOS J7", monto: -1150 },
    { numCta: "5131-0001-0000", nombre: "COSTO J7 INTERCAMBIO", monto: -730 },
    { numCta: "6300-1024-0000", nombre: "COMBUSTIBLES", monto: -175 },
  ];

  it("agrupa por rubro y calcula utilidad bruta y resultado de los dos lados", () => {
    const er = construirEstadoResultados(declarado, derivado, { presentado: true });
    expect(er.rubros.map((r) => r.clave)).toEqual(["ingresos", "costos", "gastos"]);
    expect(er.utilidadBruta.declarado).toBe(158);
    expect(er.utilidadBruta.derivado).toBe(180);
    expect(er.resultado.declarado).toBe(-12);
    expect(er.resultado.derivado).toBe(5);
    expect(er.resultado.diferencia).toBe(17);
  });

  it("una cuenta que sólo existe de un lado aparece igual, con cero enfrente", () => {
    const er = construirEstadoResultados(
      [{ numCta: "5291-0001-0000", nombre: "COSTO USADOS", monto: -40 }],
      [],
      { presentado: true },
    );
    const c = er.rubros[0].cuentas[0];
    expect(c.declarado).toBe(-40);
    expect(c.derivado).toBe(0);
    expect(c.diferencia).toBe(40);
  });

  it("el renglón más grande va primero: ahí vive la explicación", () => {
    const er = construirEstadoResultados(declarado, derivado, { presentado: true });
    expect(er.rubros[0].cuentas[0].numCta).toBe("4101-0001-0000");
  });

  it("una cuenta en ceros de los dos lados no ensucia la pantalla", () => {
    const er = construirEstadoResultados(
      [{ numCta: "4501-0002-0000", nombre: "ING BANCOS", monto: 0 }],
      [{ numCta: "4501-0002-0000", nombre: "ING BANCOS", monto: 0 }],
      { presentado: true },
    );
    expect(er.rubros).toHaveLength(0);
  });

  it("período sin presentar: sólo derivado, y lo dice", () => {
    const er = construirEstadoResultados([], derivado, { presentado: false });
    expect(er.presentado).toBe(false);
    expect(er.resultado.declarado).toBe(0);
    expect(er.resultado.derivado).toBe(5);
  });

  it("ignora cuentas de balance aunque vengan en la lista", () => {
    const er = construirEstadoResultados(
      [{ numCta: "1301-0004-0000", nombre: "INVENTARIO", monto: 500 }],
      [],
      { presentado: true },
    );
    expect(er.rubros).toHaveLength(0);
  });
});
