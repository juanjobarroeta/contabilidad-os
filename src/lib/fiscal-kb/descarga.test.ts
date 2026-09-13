import { describe, expect, it } from "vitest";
import { esErrorDeCadena, permiteCadenaRota } from "./descarga";

describe("descarga con cadena TLS rota", () => {
  it("sólo se tolera en sitios .gob.mx", () => {
    expect(permiteCadenaRota("https://www.congreso-hidalgo.gob.mx/x.pdf")).toBe(true);
    expect(permiteCadenaRota("https://data.consejeria.cdmx.gob.mx/x.pdf")).toBe(true);
    expect(permiteCadenaRota("https://evil.gob.mx.attacker.com/x.pdf")).toBe(false);
    expect(permiteCadenaRota("https://congresomich.site/x.pdf")).toBe(false);
    expect(permiteCadenaRota("no es url")).toBe(false);
  });
  it("reconoce el error de cadena de Node y no otros", () => {
    expect(esErrorDeCadena(Object.assign(new TypeError("fetch failed"), { cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE", message: "unable to verify the first certificate" } }))).toBe(true);
    expect(esErrorDeCadena(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED" } }))).toBe(false);
    expect(esErrorDeCadena(new Error("HTTP 404"))).toBe(false);
  });
});
