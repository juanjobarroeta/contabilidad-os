import { describe, it, expect } from "vitest";
import {
  ajustesDeConteo,
  caducidadImpresa,
  diferenciasDeConteo,
  digitoVerificadorGs1,
  fechaGs1,
  gtinParaMostrar,
  leerCodigo,
  normalizarGtin,
  rebasaPrecioMaximo,
} from "./codigos-barras";

describe("GTIN", () => {
  it("la caja real de CENTRO: EAN-13 7502245840289 es válido y se guarda como GTIN-14", () => {
    expect(digitoVerificadorGs1("750224584028")).toBe(9);
    expect(normalizarGtin("7502245840289")).toBe("07502245840289");
    expect(normalizarGtin("7 502245 840289")).toBe("07502245840289");
    expect(gtinParaMostrar("07502245840289")).toBe("7502245840289");
  });
  it("un verificador mal leído se rechaza (no se liga un código equivocado)", () => {
    expect(normalizarGtin("7502245840288")).toBeNull();
  });
  it("UPC-A de 12, EAN-8 y GTIN-14", () => {
    expect(normalizarGtin("036000291452")).toBe("00036000291452");
    expect(normalizarGtin("96385074")).toBe("00000096385074");
    expect(normalizarGtin("10614141000415")).toBe("10614141000415");
  });
});

describe("leerCodigo()", () => {
  it("EAN llano → tipo GTIN, sin lote ni caducidad (van impresos al lado)", () => {
    expect(leerCodigo("7502245840289\n")).toMatchObject({ tipo: "GTIN", gtin: "07502245840289", lote: null, caducidad: null });
  });
  it("GS1 con paréntesis", () => {
    expect(leerCodigo("(01)07502245840289(17)280731(10)TE26H06")).toMatchObject({
      tipo: "GS1", gtin: "07502245840289", caducidad: "2028-07-31", lote: "TE26H06",
    });
  });
  it("GS1 crudo con FNC1 (ASCII 29) y prefijo de simbología DataMatrix", () => {
    const crudo = "]d2010750224584028917280700" + "10TE26H06" + "\u001d" + "21SN0001";
    expect(leerCodigo(crudo)).toMatchObject({ tipo: "GS1", gtin: "07502245840289", caducidad: "2028-07-31", lote: "TE26H06", serie: "SN0001" });
  });
  it("lote al final sin separador", () => {
    expect(leerCodigo("010750224584028910ABC123")).toMatchObject({ gtin: "07502245840289", lote: "ABC123" });
  });
  it("lo que no es código de producto queda como OTRO", () => {
    expect(leerCodigo("HOLA-123").tipo).toBe("OTRO");
    expect(leerCodigo("").tipo).toBe("OTRO");
  });
  it("fecha GS1 con día 00 = fin de mes", () => {
    expect(fechaGs1("280200")).toBe("2028-02-29");
    expect(fechaGs1("281399")).toBeNull();
  });
});

describe("caducidadImpresa()", () => {
  it("«JUL 28» de la caja real → 31 de julio de 2028", () => {
    expect(caducidadImpresa("JUL 28")).toBe("2028-07-31");
  });
  it("otras formas comunes", () => {
    expect(caducidadImpresa("07/2028")).toBe("2028-07-31");
    expect(caducidadImpresa("2028-07")).toBe("2028-07-31");
    expect(caducidadImpresa("ago-27")).toBe("2027-08-31");
    expect(caducidadImpresa("DIC. 2026")).toBe("2026-12-31");
    expect(caducidadImpresa("algo")).toBeNull();
  });
});

describe("conteo físico", () => {
  const lotes = [
    { id: "l1", insumoId: "a", lote: "TE26H06", existencia: 10 },
    { id: "l2", insumoId: "a", lote: "X1", existencia: 4 },
    { id: "l3", insumoId: "b", lote: "Z9", existencia: 7 }, // b no se contó: no aparece
  ];
  it("compara por lote sólo los insumos contados; un lote nuevo entra completo", () => {
    const d = diferenciasDeConteo(
      [{ insumoId: "a", lote: "te26h06", cantidad: 6 }, { insumoId: "a", lote: "TE26H06", cantidad: 2 }, { insumoId: "a", lote: "NUEVO", cantidad: 3 }],
      lotes,
    );
    expect(d).toEqual([
      { insumoId: "a", lote: "TE26H06", loteId: "l1", sistema: 10, contado: 8, diferencia: -2 },
      { insumoId: "a", lote: "X1", loteId: "l2", sistema: 4, contado: null, diferencia: null },
      { insumoId: "a", lote: "NUEVO", loteId: null, sistema: 0, contado: 3, diferencia: 3 },
    ]);
  });
  it("al cerrar, el lote no contado sólo va a cero si se pide", () => {
    const d = diferenciasDeConteo([{ insumoId: "a", lote: "TE26H06", cantidad: 10 }], lotes);
    expect(ajustesDeConteo(d, false)).toEqual([]);
    expect(ajustesDeConteo(d, true)).toEqual([{ insumoId: "a", lote: "X1", loteId: "l2", cantidad: -4 }]);
  });
});

describe("precio máximo al público", () => {
  it("avisa si el precio al paciente lo rebasa", () => {
    expect(rebasaPrecioMaximo(2800, 2727.5)).toBe(true);
    expect(rebasaPrecioMaximo(2727.5, 2727.5)).toBe(false);
    expect(rebasaPrecioMaximo(5000, null)).toBe(false);
  });
});
