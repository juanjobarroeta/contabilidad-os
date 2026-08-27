import { describe, expect, it } from "vitest";
import { familiaATag, inferirPorIdentidad, type ContextoIdentidad } from "./inferir-movimiento";

const ctxVacio = (): ContextoIdentidad => ({
  rfcEmpresa: "AMA170817NK1",
  clabesPropias: new Map(),
  empleadosPorRfc: new Map(),
  espejo: null,
});

describe("inferirPorIdentidad", () => {
  it("RFC de la propia empresa → traspaso propio (alta)", () => {
    const s = inferirPorIdentidad({ monto: -5000, contraparteRfc: "ama170817nk1" }, ctxVacio());
    expect(s?.tag).toBe("INTERNAL_TRANSFER");
    expect(s?.confianza).toBe("alta");
    expect(s?.porQue).toContain("propia empresa");
  });

  it("CLABE de otra cuenta propia → traspaso propio, nombrando la cuenta", () => {
    const ctx = ctxVacio();
    ctx.clabesPropias.set("072180001234567895", "BANORTE · Operativa");
    const s = inferirPorIdentidad(
      { monto: -1200, contraparteClabe: "072180001234567895" },
      ctx
    );
    expect(s?.tag).toBe("INTERNAL_TRANSFER");
    expect(s?.porQue).toContain("BANORTE · Operativa");
  });

  it("movimiento espejo en otra cuenta → traspaso propio con cuenta y fecha", () => {
    const ctx = ctxVacio();
    ctx.espejo = { etiquetaCuenta: "BBVA · Nómina", fecha: "15/08/26" };
    const s = inferirPorIdentidad({ monto: 800 }, ctx);
    expect(s?.tag).toBe("INTERNAL_TRANSFER");
    expect(s?.porQue).toContain("BBVA · Nómina");
    expect(s?.porQue).toContain("espejo");
    expect(s?.porQue).toContain("15/08/26");
  });

  it("RFC de empleado + egreso → nómina sin CFDI (media)", () => {
    const ctx = ctxVacio();
    ctx.empleadosPorRfc.set("VESC940829TE5", "JOSE CARLOS VELEZ");
    const s = inferirPorIdentidad({ monto: -485, contraparteRfc: "VESC940829TE5" }, ctx);
    expect(s?.tag).toBe("PAYROLL_NO_CFDI");
    expect(s?.confianza).toBe("media");
    expect(s?.porQue).toContain("JOSE CARLOS VELEZ");
  });

  it("RFC de empleado pero DEPÓSITO → no afirma nada (puede ser reembolso)", () => {
    const ctx = ctxVacio();
    ctx.empleadosPorRfc.set("VESC940829TE5", "JOSE CARLOS VELEZ");
    expect(inferirPorIdentidad({ monto: 485, contraparteRfc: "VESC940829TE5" }, ctx)).toBeNull();
  });

  it("sin datos duros → null, nunca adivina", () => {
    expect(inferirPorIdentidad({ monto: -900, contraparteRfc: "XAXX010101000" }, ctxVacio())).toBeNull();
    expect(inferirPorIdentidad({ monto: -900 }, ctxVacio())).toBeNull();
  });
});

describe("familiaATag", () => {
  it("COMISION mapea al tag que postMonth postea provisionalmente", () => {
    expect(familiaATag("COMISION")).toBe("PENDING_MONTHLY_CFDI");
  });
  it("RENT y FINANCIAL_INCOME no se ofrecen: postMonth no regenera su asiento", () => {
    expect(familiaATag("RENT")).toBeNull();
    expect(familiaATag("FINANCIAL_INCOME")).toBeNull();
  });
  it("los tags directos pasan tal cual", () => {
    expect(familiaATag("TAX_PAYMENT")).toBe("TAX_PAYMENT");
    expect(familiaATag("INTERNAL_TRANSFER")).toBe("INTERNAL_TRANSFER");
  });
});
