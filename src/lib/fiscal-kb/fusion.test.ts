import { describe, expect, it } from "vitest";
import { fusionarRRF, referenciasExactas } from "./fusion";

describe("fusionarRRF", () => {
  it("un elemento que aparece en dos brazos sube por encima de los que sólo están en uno", () => {
    const vector = ["a", "b", "c"];
    const lexico = ["c", "d"];
    const out = fusionarRRF([vector, lexico], (x) => x);
    expect(out[0].item).toBe("c");
    expect(out[0].brazos).toBe(2);
    // b (2º del vector) y d (2º del léxico) empatan a 1/62; gana el primero visto.
    expect(out.map((x) => x.item)).toEqual(["c", "a", "b", "d"]);
  });
  it("un brazo vacío no rompe nada y el orden de un solo brazo se conserva", () => {
    expect(fusionarRRF([["a", "b"], []], (x) => x).map((x) => x.item)).toEqual(["a", "b"]);
  });
  it("conserva el objeto de la primera lista donde apareció", () => {
    const v = [{ id: "a", de: "vector" }];
    const l = [{ id: "a", de: "lexico" }];
    expect(fusionarRRF([v, l], (x) => x.id)[0].item.de).toBe("vector");
  });
});

describe("referenciasExactas", () => {
  it("artículo con ley, con sufijo y con Bis", () => {
    expect(referenciasExactas("¿Qué dice el artículo 27 de la LISR sobre deducciones?")).toEqual([{ articulo: "27", clave: "LISR" }]);
    expect(referenciasExactas("requisitos del art. 29-a del CFF")).toEqual([{ articulo: "29-A", clave: "CFF" }]);
    expect(referenciasExactas("¿me aplica el artículo 17-H bis?")).toEqual([{ articulo: "17-H Bis", clave: null }]);
  });
  it("artículo con fracción y sin ley; regla de la RMF", () => {
    expect(referenciasExactas("artículo 28, fracción XXX")).toEqual([{ articulo: "28", clave: null }]);
    expect(referenciasExactas("¿sigue vigente la regla 2.7.1.32?")).toEqual([{ articulo: "2.7.1.32", clave: "RMF" }]);
  });
  it("una pregunta sin números no produce referencias", () => {
    expect(referenciasExactas("¿cuándo vence la declaración mensual?")).toEqual([]);
  });
});
