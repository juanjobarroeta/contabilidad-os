import { describe, expect, it } from "vitest";
import { descargar, esErrorDeCadena, permiteCadenaRota } from "./descarga";

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

describe("descargar", () => {
  it("un fallo definitivo lleva la causa en el mensaje y no se queda en «fetch failed»", async () => {
    await expect(descargar("https://no-existe.invalid/x.pdf", {})).rejects.toThrow(/Descarga falló \((ENOTFOUND|EAI_AGAIN|getaddrinfo)[^)]*\)/);
  }, 30_000);
});
