import { describe, it, expect } from "vitest";
import {
  MAX_LARGO_CUENTA_PREDIAL,
  avisoCuentaPredial,
  cuentaPredialValida,
  cuentasPredialesDeConcepto,
  esClaveArrendamiento,
  normalizarCuentaPredial,
} from "./predial";

describe("esClaveArrendamiento", () => {
  it("reconoce la familia 801315xx de arrendamiento de inmuebles", () => {
    expect(esClaveArrendamiento("80131501")).toBe(true); // residencial
    expect(esClaveArrendamiento("80131502")).toBe(true); // comercial e industrial
    expect(esClaveArrendamiento("80131500")).toBe(true); // familia
  });

  it("no confunde otras claves ni valores vacíos", () => {
    expect(esClaveArrendamiento("84111506")).toBe(false); // servicios contables
    expect(esClaveArrendamiento("80101500")).toBe(false); // consultoría
    expect(esClaveArrendamiento("")).toBe(false);
    expect(esClaveArrendamiento(null)).toBe(false);
    expect(esClaveArrendamiento(undefined)).toBe(false);
  });

  it("tolera espacios alrededor de la clave", () => {
    expect(esClaveArrendamiento("  80131502 ")).toBe(true);
  });
});

describe("normalizarCuentaPredial", () => {
  it("recorta y colapsa espacios internos", () => {
    expect(normalizarCuentaPredial("  0102  030405 ")).toBe("0102 030405");
  });

  it("NO toca guiones, diagonales ni ceros a la izquierda", () => {
    // El formato lo define cada municipio; «limpiarlo» rompería cuentas válidas.
    expect(normalizarCuentaPredial("001-234-567/8")).toBe("001-234-567/8");
    expect(normalizarCuentaPredial("0000123")).toBe("0000123");
  });

  it("vacío y sólo espacios dan null", () => {
    expect(normalizarCuentaPredial("")).toBeNull();
    expect(normalizarCuentaPredial("   ")).toBeNull();
    expect(normalizarCuentaPredial(null)).toBeNull();
    expect(normalizarCuentaPredial(undefined)).toBeNull();
  });
});

describe("cuentaPredialValida", () => {
  it("acepta una cuenta normal y rechaza la vacía", () => {
    expect(cuentaPredialValida("0102030405")).toBe(true);
    expect(cuentaPredialValida("   ")).toBe(false);
  });

  it("rechaza lo que no cabe en el atributo del SAT", () => {
    expect(cuentaPredialValida("9".repeat(MAX_LARGO_CUENTA_PREDIAL))).toBe(true);
    expect(cuentaPredialValida("9".repeat(MAX_LARGO_CUENTA_PREDIAL + 1))).toBe(false);
  });
});

describe("avisoCuentaPredial", () => {
  it("avisa cuando una clave de arrendamiento va sin cuenta predial", () => {
    expect(avisoCuentaPredial("80131502", null)).toContain("cuenta predial");
    expect(avisoCuentaPredial("80131502", "  ")).toContain("cuenta predial");
  });

  it("calla cuando la cuenta está capturada", () => {
    expect(avisoCuentaPredial("80131502", "0102030405")).toBeNull();
  });

  it("calla en conceptos que no son arrendamiento", () => {
    expect(avisoCuentaPredial("84111506", null)).toBeNull();
  });
});

describe("cuentasPredialesDeConcepto", () => {
  it("extrae la cuenta predial del cuerpo del concepto", () => {
    const cuerpo = `<cfdi:CuentaPredial Numero="0102030405"/>`;
    expect(cuentasPredialesDeConcepto(cuerpo)).toEqual(["0102030405"]);
  });

  it("extrae VARIAS (CFDI 4.0 permite más de una por concepto)", () => {
    const cuerpo = `
      <cfdi:CuentaPredial Numero="111"/>
      <cfdi:CuentaPredial Numero="222"/>`;
    expect(cuentasPredialesDeConcepto(cuerpo)).toEqual(["111", "222"]);
  });

  it("funciona sin prefijo de namespace y con atributos alrededor", () => {
    expect(cuentasPredialesDeConcepto(`<CuentaPredial Numero="333" />`)).toEqual(["333"]);
  });

  it("un concepto sin el nodo devuelve vacío", () => {
    expect(cuentasPredialesDeConcepto(`<cfdi:Impuestos><cfdi:Traslado/></cfdi:Impuestos>`)).toEqual([]);
    expect(cuentasPredialesDeConcepto("")).toEqual([]);
  });

  it("descarta números vacíos", () => {
    expect(cuentasPredialesDeConcepto(`<cfdi:CuentaPredial Numero=""/>`)).toEqual([]);
  });
});
