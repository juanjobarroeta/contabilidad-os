import { describe, it, expect } from "vitest";
import {
  sugerirCategoriaConcepto,
  signoDeMonto,
} from "./categorizar-concepto";
import { COE_CODES } from "@/lib/contabilidad/catalog";

describe("sugerirCategoriaConcepto — familias de concepto", () => {
  it("COMISION → gastos bancarios (601.84)", () => {
    const s = sugerirCategoriaConcepto("COMISION POR MANEJO DE CUENTA", "DEBITO");
    expect(s).toMatchObject({
      familia: "COMISION",
      cuentaSugerida: COE_CODES.COMISIONES_BANCARIAS,
      confianza: "alta",
    });
  });

  it("IVA/ISR/SAT/DPA/CONTRIBUCION → impuestos (601.20)", () => {
    for (const c of [
      "PAGO IVA",
      "PAGO ISR PROVISIONAL",
      "PAGO REFERENCIADO SAT",
      "DPA DERECHOS",
      "CONTRIBUCION ESTATAL",
      "IMPUESTO PREDIAL",
    ]) {
      const s = sugerirCategoriaConcepto(c, "DEBITO");
      expect(s?.familia, c).toBe("TAX_PAYMENT");
      expect(s?.cuentaSugerida).toBe(COE_CODES.IMPUESTOS_DERECHOS);
    }
  });

  it("NOMINA/DISPERSION/PAGO DE NOMINA → nómina (601.01)", () => {
    for (const c of ["NOMINA QUINCENAL", "DISPERSION DE NOMINA", "PAGO DE NOMINA"]) {
      const s = sugerirCategoriaConcepto(c, "DEBITO");
      expect(s?.familia, c).toBe("PAYROLL_NO_CFDI");
      expect(s?.cuentaSugerida).toBe(COE_CODES.SUELDOS_SALARIOS);
    }
  });

  it("SPEI/TRASPASO/TRANSFERENCIA → traspasos (confianza media)", () => {
    for (const c of ["TRASPASO ENTRE CUENTAS", "SPEI ENVIADO", "TRANSFERENCIA"]) {
      const s = sugerirCategoriaConcepto(c, "DEBITO");
      expect(s?.familia, c).toBe("INTERNAL_TRANSFER");
      expect(s?.cuentaSugerida).toBe(COE_CODES.BANCOS);
      expect(s?.confianza).toBe("media");
    }
  });

  it("INTERES/RENDIMIENTO → productos financieros (402.01) sólo en crédito", () => {
    const credito = sugerirCategoriaConcepto("RENDIMIENTO INVERSION", "CREDITO");
    expect(credito?.familia).toBe("FINANCIAL_INCOME");
    expect(credito?.cuentaSugerida).toBe(COE_CODES.OTROS_INGRESOS);

    // En un débito, "INTERES" no debe clasificarse como ingreso ganado.
    const debito = sugerirCategoriaConcepto("INTERESES", "DEBITO");
    expect(debito?.familia).not.toBe("FINANCIAL_INCOME");
  });

  it("RENTA/ARRENDAMIENTO → rentas (601.03)", () => {
    for (const c of ["PAGO DE RENTA OFICINA", "ARRENDAMIENTO BODEGA"]) {
      const s = sugerirCategoriaConcepto(c, "DEBITO");
      expect(s?.familia, c).toBe("RENT");
      expect(s?.cuentaSugerida).toBe(COE_CODES.RENTAS);
    }
  });
});

describe("insensibilidad a mayúsculas y acentos", () => {
  it("clasifica igual con minúsculas y acentos", () => {
    const variantes = ["comisión", "COMISIÓN", "Comision", "  comisión  "];
    for (const c of variantes) {
      expect(sugerirCategoriaConcepto(c, "DEBITO")?.familia, c).toBe("COMISION");
    }
  });

  it("NÓMINA con acento se clasifica como nómina", () => {
    expect(sugerirCategoriaConcepto("DISPERSIÓN DE NÓMINA", "DEBITO")?.familia).toBe(
      "PAYROLL_NO_CFDI",
    );
  });

  it("INTERÉS con acento (crédito) es producto financiero", () => {
    expect(sugerirCategoriaConcepto("INTERÉS GANADO", "CREDITO")?.familia).toBe(
      "FINANCIAL_INCOME",
    );
  });
});

describe("conceptos desconocidos → null", () => {
  it("devuelve null para un concepto que no reconoce", () => {
    expect(sugerirCategoriaConcepto("XYZ COMPRA TIENDA DEPARTAMENTAL", "DEBITO")).toBeNull();
    expect(sugerirCategoriaConcepto("PAGO REFERENCIA 998877", "DEBITO")).toBeNull();
  });

  it("devuelve null para concepto vacío", () => {
    expect(sugerirCategoriaConcepto("", "DEBITO")).toBeNull();
    expect(sugerirCategoriaConcepto("   ", "CREDITO")).toBeNull();
  });
});

describe("signoDeMonto", () => {
  it("monto positivo = CREDITO, negativo = DEBITO", () => {
    expect(signoDeMonto(1500)).toBe("CREDITO");
    expect(signoDeMonto(-1500)).toBe("DEBITO");
    expect(signoDeMonto(0)).toBe("DEBITO");
  });
});
