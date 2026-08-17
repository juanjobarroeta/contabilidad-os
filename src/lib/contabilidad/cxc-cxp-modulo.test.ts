import { describe, it, expect } from "vitest";
import {
  cuentaDeSerie,
  moduloDeInvoice,
  kindComun,
  CXC_UNIDADES,
  type CuentaSerie,
  type KindLiquidacion,
} from "./cxc-cxp-modulo";

const cta = (cuentaSAT: string, codAgrup: string | null): CuentaSerie => ({
  id: cuentaSAT,
  cuentaSAT,
  nombre: `CUENTA ${cuentaSAT}`,
  codAgrup,
});

describe("cuentaDeSerie()", () => {
  it("la serie única bajo el agrupador resuelve", () => {
    const c = cuentaDeSerie([cta("1206-0001-0000", "105.01"), cta("1217-0001-0000", "105.01")], CXC_UNIDADES);
    expect(c?.cuentaSAT).toBe("1206-0001-0000");
  });

  it("dos activas de la misma serie (el caso 1211 IVA/NO IVA) → ambigua → null", () => {
    const c = cuentaDeSerie(
      [cta("1211-0001-0000", "105.01"), cta("1211-0002-0000", "105.01")],
      { codigo: "105.01", serie: "1211" },
    );
    expect(c).toBeNull();
  });

  it("la serie con el agrupador equivocado no resuelve", () => {
    expect(cuentaDeSerie([cta("1206-0001-0000", "106.01")], CXC_UNIDADES)).toBeNull();
  });
});

describe("moduloDeInvoice()", () => {
  const conjuntos = {
    unidades: new Set(["i-unidad"]),
    refacciones: new Set(["i-unidad", "i-refa"]), // la unidad trae refacciones en otra línea
    servicios: new Set(["i-serv"]),
  };

  it("la unidad manda aunque el CFDI también traiga refacciones", () => {
    expect(moduloDeInvoice("i-unidad", conjuntos)).toBe("unidades");
  });

  it("refacciones y servicio resuelven a su módulo; lo demás a null", () => {
    expect(moduloDeInvoice("i-refa", conjuntos)).toBe("refacciones");
    expect(moduloDeInvoice("i-serv", conjuntos)).toBe("servicio");
    expect(moduloDeInvoice("i-otro", conjuntos)).toBeNull();
  });
});

describe("kindComun()", () => {
  const kinds = new Map<string, KindLiquidacion>([
    ["n1", "NOMINA"],
    ["n2", "NOMINA"],
    ["u1", "unidades"],
  ]);

  it("todas del mismo kind → ese kind (el pago de la quincena concilia varias nóminas)", () => {
    expect(kindComun(kinds, ["n1", "n2"])).toBe("NOMINA");
  });

  it("mezcla de kinds → null: no se reparte a ciegas, fallback", () => {
    expect(kindComun(kinds, ["n1", "u1"])).toBeNull();
  });

  it("sin facturas o kind desconocido → null", () => {
    expect(kindComun(kinds, [])).toBeNull();
    expect(kindComun(kinds, ["desconocida"])).toBeNull();
  });
});
