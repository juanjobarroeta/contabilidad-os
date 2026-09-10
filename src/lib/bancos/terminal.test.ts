import { describe, expect, it } from "vitest";
import { cercaPeroNoExactoEnLote, mismoImporte, tarjetaDeLiquidacion, tarjetaContradice } from "./terminal";

describe("tarjetaDeLiquidacion — el sufijo de la afiliación", () => {
  it("lee C como crédito y D como débito", () => {
    expect(tarjetaDeLiquidacion("HOSP HALTUS 09992888C")).toBe("CREDITO");
    expect(tarjetaDeLiquidacion("HOSP HALTUS 09992886D")).toBe("DEBITO");
    expect(tarjetaDeLiquidacion("HOSPITAL HALTUS 09992889C")).toBe("CREDITO");
  });

  it("sin sufijo legible no inventa", () => {
    expect(tarjetaDeLiquidacion("DEPOSITO VENTAS DEL DIA AFIL.-009951074")).toBeNull();
    expect(tarjetaDeLiquidacion("SPEI RECIBIDO BANORTE")).toBeNull();
    expect(tarjetaDeLiquidacion("")).toBeNull();
  });
});

describe("tarjetaContradice — dinero de crédito no liquida una factura de débito", () => {
  it("contradicción explícita", () => {
    // Caso real: depósito 09992888C (crédito) sugerido contra HH1421, que
    // declara forma de pago 28 (débito), con $58.84 de diferencia que parecía
    // una comisión y no lo era.
    expect(tarjetaContradice("CREDITO", "28")).toBe(true);
    expect(tarjetaContradice("DEBITO", "04")).toBe(true);
  });

  it("coincidencia no contradice", () => {
    expect(tarjetaContradice("CREDITO", "04")).toBe(false);
    expect(tarjetaContradice("DEBITO", "28")).toBe(false);
  });

  it("lo que no es tarjeta NO se descarta: puede estar mal capturado", () => {
    // «99 por definir» es lo que se emite cuando no se sabe cómo van a pagar,
    // y hay 56 facturas así. Descartarlas escondería la respuesta correcta.
    for (const forma of ["99", "01", "03", "17", null, undefined, ""]) {
      expect(tarjetaContradice("CREDITO", forma)).toBe(false);
      expect(tarjetaContradice("DEBITO", forma)).toBe(false);
    }
  });

  it("sin tarjeta identificada no descarta nada", () => {
    expect(tarjetaContradice(null, "04")).toBe(false);
    expect(tarjetaContradice(null, "28")).toBe(false);
  });
});

describe("mismoImporte — un centavo dentro del lote es redondeo, no otra factura", () => {
  it("caso real: depósito $10,869.99 contra factura $10,870.00 el mismo día", () => {
    expect(mismoImporte(10870.0, 10869.99, true)).toBe(true);
  });

  it("fuera de la terminal, un centavo SÍ distingue", () => {
    // En una transferencia el importe es el que alguien tecleó. Y este
    // proveedor tiene facturas de $16,999.99, $17,000.00 y $17,000.01.
    expect(mismoImporte(17000.0, 16999.99, false)).toBe(false);
  });

  it("dos centavos ya no son redondeo ni en el lote", () => {
    expect(mismoImporte(10870.0, 10869.98, true)).toBe(false);
  });
});

describe("cercaPeroNoExactoEnLote", () => {
  it("un centavo NO se castiga en el lote", () => {
    expect(cercaPeroNoExactoEnLote(true, 10870.0, 10869.99)).toBe(false);
  });

  it("0.3 % sí: en un lote, «cerca» no es una pista", () => {
    expect(cercaPeroNoExactoEnLote(true, 84773.14, 84500.47)).toBe(true);
  });

  it("fuera del lote no se castiga nada", () => {
    expect(cercaPeroNoExactoEnLote(false, 84773.14, 84500.47)).toBe(false);
  });
});
