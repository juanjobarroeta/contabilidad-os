import { describe, it, expect } from "vitest";
import { ivaEsperadoPorClave, contradiccionIva } from "./iva-esperado";

// Las claves usadas aquí existen en el catálogo c_ClaveProdServ vigente del
// SAT (verificadas al curar el mapa); los comentarios citan su descripción.

describe("ivaEsperadoPorClave", () => {
  it("reconoce agua natural (50202301 Agua) como tasa cero", () => {
    const out = ivaEsperadoPorClave("50202301");
    expect(out?.tratamiento).toBe("0");
    expect(out?.etiqueta).toContain("agua");
    expect(out?.fundamento).toContain("Art. 2o.-A");
  });

  it("reconoce hielo (50202302) como tasa cero", () => {
    expect(ivaEsperadoPorClave("50202302")?.tratamiento).toBe("0");
  });

  it("NO opina sobre el resto de las bebidas de la clase 502023", () => {
    expect(ivaEsperadoPorClave("50202306")).toBeNull(); // Refrescos
    expect(ivaEsperadoPorClave("50202310")).toBeNull(); // Agua mineral (gaseosa)
    expect(ivaEsperadoPorClave("50202309")).toBeNull(); // Bebidas deportivas
  });

  it("reconoce leche y lácteos básicos (clase 501317) como tasa cero", () => {
    expect(ivaEsperadoPorClave("50131701")?.tratamiento).toBe("0"); // frescos
    expect(ivaEsperadoPorClave("50131704")?.tratamiento).toBe("0"); // leche en polvo
  });

  it("excluye los suplementos dentro de la clase de lácteos", () => {
    expect(ivaEsperadoPorClave("50131705")).toBeNull(); // Proteína de suero de leche
    expect(ivaEsperadoPorClave("50131706")).toBeNull(); // Lactosa
  });

  it("reconoce huevo (clase 501316) como tasa cero", () => {
    expect(ivaEsperadoPorClave("50131612")?.tratamiento).toBe("0"); // Huevos de gallina
    expect(ivaEsperadoPorClave("50131627")?.tratamiento).toBe("0"); // Huevos cocidos
  });

  it("reconoce fruta y verdura fresca (5030/5031/5040/5041) como tasa cero", () => {
    expect(ivaEsperadoPorClave("50301500")?.tratamiento).toBe("0"); // Manzanas
    expect(ivaEsperadoPorClave("50311700")?.tratamiento).toBe("0"); // Bananos orgánicos
    expect(ivaEsperadoPorClave("50405702")?.tratamiento).toBe("0"); // Papas
    expect(ivaEsperadoPorClave("50411500")?.tratamiento).toBe("0"); // Alcachofas orgánicas
  });

  it("excluye los subproductos de frutas frescas (clase 503075)", () => {
    // 50307502 "Extracto de naranja para mezclar en agua" — concentrado para
    // bebidas, gravado al 16% (Art. 2o.-A, fracc. I, inciso b), numeral 2).
    expect(ivaEsperadoPorClave("50307502")).toBeNull();
  });

  it("NO opina sobre fruta/verdura procesada (seca, congelada, enlatada)", () => {
    expect(ivaEsperadoPorClave("50321500")).toBeNull(); // Manzanas secas
    expect(ivaEsperadoPorClave("50341500")).toBeNull(); // Manzanas congeladas
    expect(ivaEsperadoPorClave("50461500")).toBeNull(); // Alcachofas en lata
  });

  it("reconoce medicamentos (segmento 51) como tasa cero", () => {
    expect(ivaEsperadoPorClave("51101602")?.tratamiento).toBe("0"); // antibióticos
    expect(ivaEsperadoPorClave("51191802")?.tratamiento).toBe("0"); // Cloruro de potasio
    const med = ivaEsperadoPorClave("51142001");
    expect(med?.etiqueta).toBe("medicinas de patente");
  });

  it("excluye los suplementos dentro del segmento de medicamentos", () => {
    expect(ivaEsperadoPorClave("51191905")).toBeNull(); // Suplementos vitamínicos
    expect(ivaEsperadoPorClave("51191902")).toBeNull(); // Suplementos de amino ácidos
    expect(ivaEsperadoPorClave("51191805")).toBeNull(); // Suplemento de potasio
  });

  it("regresa null para claves no curadas (la gran mayoría)", () => {
    expect(ivaEsperadoPorClave("84111506")).toBeNull(); // servicios de contabilidad
    expect(ivaEsperadoPorClave("43211508")).toBeNull(); // computadoras
    expect(ivaEsperadoPorClave("01010101")).toBeNull(); // no existe en el catálogo
    expect(ivaEsperadoPorClave("50181901")).toBeNull(); // pan fresco (no curado)
  });

  it("regresa null para entradas que no son una clave de 8 dígitos", () => {
    expect(ivaEsperadoPorClave("")).toBeNull();
    expect(ivaEsperadoPorClave("5030")).toBeNull(); // prefijo a medio escribir
    expect(ivaEsperadoPorClave("agua")).toBeNull();
    expect(ivaEsperadoPorClave("503015001")).toBeNull(); // 9 dígitos
    expect(ivaEsperadoPorClave(" 50301500 ")?.tratamiento).toBe("0"); // se tolera espacio
  });
});

describe("contradiccionIva", () => {
  it("señala la contradicción cuando una clave de tasa cero lleva IVA 16%", () => {
    const out = contradiccionIva("50202301", "16");
    expect(out?.tratamiento).toBe("0");
  });

  it("señala la contradicción cuando una clave de tasa cero lleva Exento", () => {
    expect(contradiccionIva("50202301", "EXENTO")?.tratamiento).toBe("0");
  });

  it("no señala nada cuando la selección coincide con lo esperado", () => {
    expect(contradiccionIva("50202301", "0")).toBeNull();
  });

  it("no señala nada para claves no curadas, sea cual sea la selección", () => {
    expect(contradiccionIva("84111506", "16")).toBeNull();
    expect(contradiccionIva("84111506", "0")).toBeNull();
    expect(contradiccionIva("84111506", "EXENTO")).toBeNull();
    expect(contradiccionIva("", "16")).toBeNull();
  });
});
