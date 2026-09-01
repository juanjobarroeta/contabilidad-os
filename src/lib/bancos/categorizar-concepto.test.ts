import { describe, it, expect } from "vitest";
import {
  sugerirCategoriaConcepto,
  signoDeMonto,
  primeraReglaQueEmpata,
  type CompanyRule,
} from "./categorizar-concepto";
import { extraerTokenConcepto } from "./reglas-categorizacion";
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

  it("PRESTAMO → familia por signo (crédito recibido, débito otorgado)", () => {
    // Caso real BanBajío: "ABONO PRESTAMO Recibo # 26" (+$10,000).
    const credito = sugerirCategoriaConcepto("ABONO PRESTAMO Recibo # 26", "CREDITO");
    expect(credito?.familia).toBe("LOAN_RECEIVED");
    expect(credito?.cuentaSugerida).toBe(COE_CODES.PRESTAMOS_RECIBIDOS);
    expect(credito?.confianza).toBe("media");

    const debito = sugerirCategoriaConcepto("PRESTAMO", "DEBITO");
    expect(debito?.familia).toBe("LOAN_GIVEN");
    expect(debito?.cuentaSugerida).toBe(COE_CODES.PRESTAMOS_OTORGADOS);

    // El signo manda: un crédito jamás sugiere "otorgado" ni viceversa.
    expect(sugerirCategoriaConcepto("PRESTAMO", "CREDITO")?.familia).toBe("LOAN_RECEIVED");
    expect(sugerirCategoriaConcepto("PRESTAMO", "DEBITO")?.familia).not.toBe("LOAN_RECEIVED");
  });

  it("sólo frases de cuenta propia → traspasos (confianza media)", () => {
    for (const c of ["TRASPASO ENTRE CUENTAS", "TRANSFERENCIA PROPIA REF 99", "PAGO CUENTA PROPIA"]) {
      const s = sugerirCategoriaConcepto(c, "DEBITO");
      expect(s?.familia, c).toBe("INTERNAL_TRANSFER");
      expect(s?.cuentaSugerida).toBe(COE_CODES.BANCOS);
      expect(s?.confianza).toBe("media");
    }
  });

  it("SPEI/TRANSFERENCIA a secas NO huelen a traspaso", () => {
    // Todo pago interbancario en México imprime "SPEI" en el concepto — un
    // pago real de un tercero no debe recibir "Parece Traspaso" (bug visto en
    // BanBajío: "ABONO PRESTAMO ... (SPEI; Banca por Internet)").
    for (const c of [
      "ABONO PRESTAMO Recibo # 26 (SPEI; Banca por Internet)",
      "SPEI ENVIADO",
      "TRANSFERENCIA",
      "PAGO FACTURA por 193333.34 SPEI 014 SANTANDER",
    ]) {
      const s = sugerirCategoriaConcepto(c, "DEBITO");
      expect(s?.familia, c).not.toBe("INTERNAL_TRANSFER");
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

describe("reglas persistidas de la empresa (companyRules)", () => {
  const reglaRappi: CompanyRule = { pattern: "RAPPI", familia: "NON_DEDUCTIBLE" };

  it("una regla del usuario clasifica un concepto que las REGLAS no reconocen", () => {
    // Sin reglas → desconocido.
    expect(sugerirCategoriaConcepto("COMPRA RAPPI MX", "DEBITO")).toBeNull();
    // Con la regla del usuario → NON_DEDUCTIBLE (603.01).
    const s = sugerirCategoriaConcepto("COMPRA RAPPI MX", "DEBITO", [reglaRappi]);
    expect(s).toMatchObject({
      familia: "NON_DEDUCTIBLE",
      cuentaSugerida: COE_CODES.GASTOS_NO_DEDUCIBLES,
      confianza: "alta",
    });
  });

  it("la regla del usuario GANA sobre el motor hardcodeado", () => {
    // "COMISION" normalmente → COMISION; una regla del usuario la re-mapea.
    const s = sugerirCategoriaConcepto("COMISION SERVICIO", "DEBITO", [
      { pattern: "COMISION", familia: "NON_DEDUCTIBLE" },
    ]);
    expect(s?.familia).toBe("NON_DEDUCTIBLE");
  });

  it("es insensible a mayúsculas y acentos en el patrón y el concepto", () => {
    const s = sugerirCategoriaConcepto("pago café münchën", "DEBITO", [
      { pattern: "cafe munchen", familia: "NON_DEDUCTIBLE" },
    ]);
    expect(s?.familia).toBe("NON_DEDUCTIBLE");
  });

  it("respeta el signo de la regla", () => {
    const reglas: CompanyRule[] = [{ pattern: "INTERESES", familia: "FINANCIAL_INCOME", signo: "CREDITO" }];
    expect(sugerirCategoriaConcepto("INTERESES", "CREDITO", reglas)?.familia).toBe("FINANCIAL_INCOME");
    // En un débito la regla no aplica → cae al motor (que tampoco lo clasifica como ingreso).
    expect(sugerirCategoriaConcepto("INTERESES", "DEBITO", reglas)?.familia).not.toBe("FINANCIAL_INCOME");
  });

  it("matchType EXACT y STARTS_WITH", () => {
    const exacto: CompanyRule[] = [{ pattern: "OXXO", familia: "NON_DEDUCTIBLE", matchType: "EXACT" }];
    expect(sugerirCategoriaConcepto("OXXO", "DEBITO", exacto)?.familia).toBe("NON_DEDUCTIBLE");
    expect(sugerirCategoriaConcepto("COMPRA OXXO 123", "DEBITO", exacto)).toBeNull();

    const prefijo: CompanyRule[] = [{ pattern: "UBER", familia: "NON_DEDUCTIBLE", matchType: "STARTS_WITH" }];
    expect(sugerirCategoriaConcepto("UBER EATS", "DEBITO", prefijo)?.familia).toBe("NON_DEDUCTIBLE");
    expect(sugerirCategoriaConcepto("PAGO UBER", "DEBITO", prefijo)).toBeNull();
  });

  it("primeraReglaQueEmpata devuelve la regla (con sus campos extra)", () => {
    const reglas = [
      { id: "r1", pattern: "OPENAI", familia: "NON_DEDUCTIBLE" as const },
      { id: "r2", pattern: "ANTHROPIC", familia: "NON_DEDUCTIBLE" as const },
    ];
    expect(primeraReglaQueEmpata("PAGO ANTHROPIC", "DEBITO", reglas)?.id).toBe("r2");
    expect(primeraReglaQueEmpata("SIN COINCIDENCIA", "DEBITO", reglas)).toBeNull();
  });
});

describe("extraerTokenConcepto", () => {
  it("extrae el token de comercio más distintivo", () => {
    expect(extraerTokenConcepto("COMPRA RAPPI MX")).toBe("RAPPI");
    expect(extraerTokenConcepto("PAGO SPEI ANTHROPIC PBC")).toBe("ANTHROPIC");
    expect(extraerTokenConcepto("compra openai chatgpt")).toBe("CHATGPT");
  });

  it("ignora ruido bancario y devuelve '' cuando no hay nada útil", () => {
    expect(extraerTokenConcepto("SPEI PAGO REF 12345")).toBe("");
    expect(extraerTokenConcepto("")).toBe("");
  });

  it("normaliza acentos a mayúsculas sin diacríticos", () => {
    expect(extraerTokenConcepto("café münchen")).toBe("MUNCHEN");
  });
});
