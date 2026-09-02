import { describe, expect, it } from "vitest";
import { planearTraspasos, subcuentaBancoSpec, IGNORED_TAGS_VALIDOS } from "./posting";

const CLABE_X = "012180001111111111";
const CLABE_Y = "014180002222222222";
const porClabe = new Map([
  [CLABE_X, "ba-x"],
  [CLABE_Y, "ba-y"],
]);

function traspaso(over: Partial<Parameters<typeof planearTraspasos>[0][number]>) {
  return {
    id: "t1",
    monto: -1000,
    bankAccountId: "ba-x",
    contraparteClabe: CLABE_Y,
    status: "IGNORED",
    notes: "INTERNAL_TRANSFER",
    ...over,
  };
}

describe("planearTraspasos — pólizas cruzadas sin duplicar", () => {
  it("retiro con contraparte propia → cruzado; su depósito espejo → cubierto", () => {
    const plan = planearTraspasos(
      [
        traspaso({ id: "salida", monto: -1000 }),
        traspaso({ id: "entrada", monto: 1000, bankAccountId: "ba-y", contraparteClabe: CLABE_X }),
      ],
      porClabe,
    );
    expect(plan.get("salida")).toEqual({ modo: "cruzado", contraparteBankAccountId: "ba-y" });
    expect(plan.get("entrada")).toEqual({ modo: "cubierto" });
  });

  it("depósito sin retiro espejo (la otra cuenta no sincronizó) → postea cruzado él mismo", () => {
    const plan = planearTraspasos(
      [traspaso({ id: "entrada", monto: 500, bankAccountId: "ba-y", contraparteClabe: CLABE_X })],
      porClabe,
    );
    expect(plan.get("entrada")).toEqual({ modo: "cruzado", contraparteBankAccountId: "ba-x" });
  });

  it("dos traspasos idénticos el mismo mes: cada depósito cubre exactamente un retiro", () => {
    const plan = planearTraspasos(
      [
        traspaso({ id: "s1", monto: -1000 }),
        traspaso({ id: "s2", monto: -1000 }),
        traspaso({ id: "e1", monto: 1000, bankAccountId: "ba-y", contraparteClabe: CLABE_X }),
        traspaso({ id: "e2", monto: 1000, bankAccountId: "ba-y", contraparteClabe: CLABE_X }),
        traspaso({ id: "e3", monto: 1000, bankAccountId: "ba-y", contraparteClabe: CLABE_X }),
      ],
      porClabe,
    );
    expect(plan.get("e1")).toEqual({ modo: "cubierto" });
    expect(plan.get("e2")).toEqual({ modo: "cubierto" });
    // el tercero no tiene retiro espejo: postea él mismo
    expect(plan.get("e3")).toEqual({ modo: "cruzado", contraparteBankAccountId: "ba-x" });
  });

  it("contraparte no resoluble o la misma cuenta → lavado visible", () => {
    const plan = planearTraspasos(
      [
        traspaso({ id: "ajena", contraparteClabe: "058180009999999999" }),
        traspaso({ id: "self", contraparteClabe: CLABE_X }),
        traspaso({ id: "sin", contraparteClabe: null }),
      ],
      porClabe,
    );
    expect(plan.get("ajena")).toEqual({ modo: "lavado" });
    expect(plan.get("self")).toEqual({ modo: "lavado" });
    expect(plan.get("sin")).toEqual({ modo: "lavado" });
  });

  it("ignora todo lo que no sea IGNORED+INTERNAL_TRANSFER", () => {
    const plan = planearTraspasos(
      [traspaso({ id: "m", status: "MATCHED" }), traspaso({ id: "otro", notes: "TAX_PAYMENT" })],
      porClabe,
    );
    expect(plan.size).toBe(0);
  });
});

describe("subcuentaBancoSpec", () => {
  const base = {
    cuentaSAT: "102.01",
    subcuenta: null,
    nombre: "Bancos",
    tipo: "ACTIVO",
    nivel: 1,
    codAgrup: null,
  };

  it("hijo bajo el código base, nivel +1, nombre con banco y últimos 4 dígitos", () => {
    const s = subcuentaBancoSpec(base, { banco: "BBVA", numeroCuenta: "0123456789" }, 1);
    expect(s.subcuenta).toBe("102.01.01");
    expect(s.nivel).toBe(2);
    expect(s.nombre).toBe("Bancos — BBVA 6789");
  });

  it("CodAgrup hereda el del padre — el código hijo NO está en la enum del SAT", () => {
    const s1 = subcuentaBancoSpec(base, { banco: "BBVA", numeroCuenta: "0123456789" }, 2);
    expect(s1.codAgrup).toBe("102.01"); // semilla: el código base ES el agrupador
    const s2 = subcuentaBancoSpec(
      { ...base, subcuenta: "1102-0001", cuentaSAT: "1102", codAgrup: "102.01" },
      { banco: "Santander", numeroCuenta: "555" },
      1,
    );
    expect(s2.subcuenta).toBe("1102-0001.01"); // plan propio: bajo SU código
    expect(s2.codAgrup).toBe("102.01"); // y con el agrupador REAL importado
  });
});

describe("IGNORED_TAGS_VALIDOS", () => {
  it("los diez tags del contrato, y nada más", () => {
    // RENT y FINANCIAL_INCOME entraron cuando el flujo de Movimientos ya podía
    // etiquetarlas pero el cierre las rechazaba como "sin categoría".
    expect([...IGNORED_TAGS_VALIDOS].sort()).toEqual([
      "CAPITAL_CONTRIBUTION",
      "FINANCIAL_INCOME",
      "INTERNAL_TRANSFER",
      "LOAN_GIVEN",
      "LOAN_RECEIVED",
      "NON_DEDUCTIBLE",
      "PAYROLL_NO_CFDI",
      "PENDING_MONTHLY_CFDI",
      "RENT",
      "TAX_PAYMENT",
    ]);
  });
});

// ─── Ola C: reclasificación de IVA al flujo ─────────────────────────────────
import { reclasificacionIvaFlujo } from "./posting";

describe("reclasificacionIvaFlujo — Art. 1-B, proporcional al pago", () => {
  const ingreso = { tipo: "INGRESO", total: 1160, subtotal: 1000 };
  const egreso = { tipo: "EGRESO", total: 2320, subtotal: 2000 };

  it("cobro completo de un ingreso: reclasifica el delta exacto", () => {
    expect(reclasificacionIvaFlujo(1160, ingreso, true)).toEqual({ lado: "TRASLADADO", monto: 160 });
  });

  it("cobro parcial: proporcional — media factura, medio IVA", () => {
    expect(reclasificacionIvaFlujo(580, ingreso, true)).toEqual({ lado: "TRASLADADO", monto: 80 });
  });

  it("pago de un egreso: acreditable pendiente → pagado", () => {
    expect(reclasificacionIvaFlujo(2320, egreso, false)).toEqual({ lado: "ACREDITABLE", monto: 320 });
  });

  it("con retenciones (delta neto), la pendiente queda en cero al liquidar", () => {
    // Honorarios: subtotal 1000, IVA 160, ret ISR 100 y ret IVA 106.67 →
    // total 953.33; delta = −46.67 < 0 → el devengo no tocó 209 → null.
    expect(reclasificacionIvaFlujo(953.33, { tipo: "INGRESO", total: 953.33, subtotal: 1000 }, true)).toBeNull();
    // Arrendamiento con delta positivo chico: reclasifica ese delta, no el IVA bruto.
    const arr = { tipo: "INGRESO", total: 1053.33, subtotal: 1000 };
    expect(reclasificacionIvaFlujo(1053.33, arr, true)).toEqual({ lado: "TRASLADADO", monto: 53.33 });
  });

  it("dirección equivocada o sin IVA → null", () => {
    expect(reclasificacionIvaFlujo(1160, ingreso, false)).toBeNull(); // "pago" de un ingreso
    expect(reclasificacionIvaFlujo(500, { tipo: "EGRESO", total: 500, subtotal: 500 }, false)).toBeNull();
    expect(reclasificacionIvaFlujo(0, ingreso, true)).toBeNull();
  });
});
