import { describe, expect, it } from "vitest";
import { clasificarCargoBancario } from "./clasificar-cargo";

const tag = (d: string, monto = -100) => clasificarCargoBancario(d, monto);

describe("cargos de terminal — renglones reales de estados de cuenta", () => {
  it("la tasa de descuento del adquirente es comisión, aunque no lo diga", () => {
    expect(tag("COBRO POR TASA DE DESCUENTO AFIL.-009951074")).toBe("PENDING_MONTHLY_CFDI");
    expect(tag("RENTA TERMINAL PUNTO DE VENTA AFIL.-0099")).toBe("PENDING_MONTHLY_CFDI");
  });

  it("su IVA va aparte y NO es gasto", () => {
    expect(tag("COBRO IVA AFIL.-009951074")).toBe("IVA_COMISION");
  });

  it("el IVA deletreado también: caía como gasto y es impuesto acreditable", () => {
    // «I V A POR COMISION» no pegaba con \biva\b, así que la regla de comisión
    // se lo llevaba a gasto. Mismo error que ya se corrigió con «IVA COM.».
    expect(tag("I V A POR COMISION")).toBe("IVA_COMISION");
    expect(tag("I V A POR COMISION MEMBRESIA")).toBe("IVA_COMISION");
    expect(tag("I.V.A. POR COMISION")).toBe("IVA_COMISION");
  });

  it("las formas que ya funcionaban siguen funcionando", () => {
    expect(tag("IVA COMISION 15D")).toBe("IVA_COMISION");
    expect(tag("IVA COM. TRANS. AMEX")).toBe("IVA_COMISION");
    expect(tag("COMISION 15D APLICACION DE TASAS DE DESCUENTO DE DEBITO")).toBe("PENDING_MONTHLY_CFDI");
    expect(tag("COMISION MEMBRESIA P. MORAL 2")).toBe("PENDING_MONTHLY_CFDI");
  });

  it("el IVA gana a la comisión cuando el renglón dice las dos", () => {
    // Si se invierte el orden, el impuesto se registra como gasto.
    expect(tag("IVA COMISION APLICACION DE TASAS DE DESCUENTO")).toBe("IVA_COMISION");
  });

  it("impuestos, traspasos propios y ruido siguen igual", () => {
    expect(tag("PAGO DE IMPUESTOS SAT")).toBe("TAX_PAYMENT");
    expect(tag("TRASPASO ENTRE CUENTAS PROPIAS")).toBe("INTERNAL_TRANSFER");
    expect(tag("COMPENSACION POR RETRASO")).toBe("BANK_NOISE");
    expect(tag("CUALQUIER COSA", 0)).toBe("BANK_NOISE");
  });

  it("un depósito de ventas NO es un cargo de terminal", () => {
    // Mismo prefijo «AFIL.-», sentido contrario: es la liquidación, el ingreso.
    expect(tag("DEPOSITO VENTAS DEL DIA AFIL.-009951074", 2309.41)).toBeNull();
  });

  it("lo que no es de éstos se queda para la mesa", () => {
    expect(tag("SPEI ENVIADO BANORTE")).toBeNull();
    expect(tag("PAGO CUENTA DE TERCERO")).toBeNull();
  });
});
