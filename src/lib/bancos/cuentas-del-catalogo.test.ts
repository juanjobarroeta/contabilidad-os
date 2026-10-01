import { describe, expect, it } from "vitest";
import { bancoDeNombre, numeroDeNombre, sugerirCuentasBancarias, type CuentaCatalogo } from "./cuentas-del-catalogo";
import { mapCsfObligacion } from "@/lib/obligaciones";
import { balanzaPorPeriodo, catalogoMasReciente } from "@/lib/contabilidad/ce-serie-sat";
import type { CeXml } from "@/lib/contabilidad/ce-descarga-sat";

const cta = (id: string, codigo: string, nombre: string, extra: Partial<CuentaCatalogo> = {}): CuentaCatalogo => ({
  id,
  cuentaSAT: codigo.split(".")[0],
  subcuenta: codigo.includes(".") ? codigo : null,
  nombre,
  codAgrup: "102.01",
  padreCodigo: null,
  isActive: true,
  ...extra,
});

describe("cuentas bancarias del catálogo", () => {
  it("reconoce banco y número del nombre", () => {
    expect(bancoDeNombre("Bancomer Cta 0120809012")).toBe("BBVA");
    expect(bancoDeNombre("Citibanamex inversión")).toBe("Banamex");
    expect(bancoDeNombre("Caja chica")).toBeNull();
    expect(numeroDeNombre("Bancomer Cta 0120 809 012")).toBe("0120809012");
    expect(numeroDeNombre("Santander 12")).toBeNull();
  });

  it("sugiere las hojas de 102.01/102.02 que no están registradas", () => {
    const catalogo = [
      cta("p", "102.01", "Bancos nacionales", { padreCodigo: null }),
      cta("a", "102.01.01", "BBVA 0123454821", { padreCodigo: "102.01" }),
      cta("b", "102.01.02", "Santander", { padreCodigo: "102.01" }),
      cta("c", "102.02.01", "BBVA dólares 9988776655", { padreCodigo: "102.02", codAgrup: "102.02" }),
      cta("d", "102.01.03", "Banorte 5555666677", { padreCodigo: "102.01" }),
      cta("e", "102.01.04", "HSBC vieja", { padreCodigo: "102.01", isActive: false }),
      cta("f", "101.01", "Caja", { codAgrup: "101.01" }),
    ];
    const s = sugerirCuentasBancarias(catalogo, [{ chartAccountId: null, numeroCuenta: "5555666677", clabe: null }]);
    expect(s.map((x) => x.chartAccountId)).toEqual(["a", "b", "c"]);
    expect(s[0]).toMatchObject({ banco: "BBVA", numero: "0123454821", moneda: "MXN" });
    expect(s[1]).toMatchObject({ banco: "Santander", numero: null });
    expect(s[2].moneda).toBe("USD");
  });

  it("una cuenta ya ligada no se vuelve a sugerir", () => {
    const s = sugerirCuentasBancarias([cta("a", "102.01.01", "BBVA 4821")], [{ chartAccountId: "a", numeroCuenta: "x", clabe: null }]);
    expect(s).toEqual([]);
  });

  it("sin agrupador, cae al código 102 con subcuenta", () => {
    const s = sugerirCuentasBancarias([cta("a", "102.05", "Banregio 1234567", { codAgrup: null })], []);
    expect(s).toHaveLength(1);
  });
});

describe("CSF → obligaciones", () => {
  it("las retenciones de ISR ya no caen en ISR provisional", () => {
    expect(mapCsfObligacion("Entero de retenciones mensuales de ISR por sueldos y salarios")).toBe("RETENCIONES_ISR");
    expect(mapCsfObligacion("Entero de retenciones de ISR por servicios profesionales. Mensual")).toBe("RETENCIONES_ISR");
    expect(mapCsfObligacion("Entero de retención de IVA")).toBe("IVA_MENSUAL");
  });
  it("lo de siempre sigue igual", () => {
    expect(mapCsfObligacion("Pago provisional mensual de ISR personas morales régimen general")).toBe("ISR_PROVISIONAL");
    expect(mapCsfObligacion("Pago definitivo mensual de IVA")).toBe("IVA_MENSUAL");
    expect(mapCsfObligacion("Declaración informativa de IVA con proveedores")).toBe("DIOT");
    expect(mapCsfObligacion("Declaración anual de ISR del ejercicio personas morales")).toBe("ISR_ANUAL");
  });
  it("las informativas que no son DIOT no se vigilan como pagos", () => {
    expect(mapCsfObligacion("Declaración informativa anual de pagos y retenciones de servicios profesionales")).toBeNull();
    expect(mapCsfObligacion("Declaración informativa de IVA con la anual de ISR")).toBeNull();
  });
});

describe("CE del SAT: lo que se guarda", () => {
  const x = (nombre: string, tipo: string, anio = 2026, mes = 1): CeXml => ({ nombre, tipo, codigo: nombre.slice(-6, -4), anio, mes, xml: "<x/>" });
  it("la complementaria gana a la normal del mismo período", () => {
    const m = balanzaPorPeriodo([x("A202601BN.xml", "B"), x("A202601BC.xml", "B"), x("A202602BN.xml", "B", 2026, 2), x("A202601CT.xml", "CT")]);
    expect(m.size).toBe(2);
    expect(m.get("2026-1")?.nombre).toBe("A202601BC.xml");
  });
  it("el catálogo más reciente", () => {
    expect(catalogoMasReciente([x("A202401CT.xml", "CT", 2024, 1), x("A202507CT.xml", "CT", 2025, 7), x("A202503CT.xml", "CT", 2025, 3)])?.nombre).toBe("A202507CT.xml");
    expect(catalogoMasReciente([])).toBeNull();
  });
});
