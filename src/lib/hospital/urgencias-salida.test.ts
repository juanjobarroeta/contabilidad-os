import { describe, expect, it } from "vitest";
import { debePagarAntes, mensajeCuentaUrgencias, saleDeUrgencias } from "./urgencias-salida";

describe("salir de Urgencias", () => {
  it("de una cama de Urgencias a otra área exige cuenta cerrada; entre camas de Urgencias no", () => {
    expect(saleDeUrgencias({ tipoEpisodio: "URGENCIAS", areaOrigen: "URGENCIAS", areaDestino: "HOSPITALIZACION" })).toBe(true);
    expect(saleDeUrgencias({ tipoEpisodio: "URGENCIAS", areaOrigen: "URGENCIAS", areaDestino: "TERAPIA" })).toBe(true);
    expect(saleDeUrgencias({ tipoEpisodio: "URGENCIAS", areaOrigen: "URGENCIAS", areaDestino: "URGENCIAS" })).toBe(false);
  });
  it("un ingreso de urgencias sin cama también sale; uno hospitalizado no", () => {
    expect(saleDeUrgencias({ tipoEpisodio: "URGENCIAS", areaOrigen: null, areaDestino: "HOSPITALIZACION" })).toBe(true);
    expect(saleDeUrgencias({ tipoEpisodio: "HOSPITALIZACION", areaOrigen: "HOSPITALIZACION", areaDestino: "TERAPIA" })).toBe(false);
    expect(saleDeUrgencias({ tipoEpisodio: "HOSPITALIZACION", areaOrigen: null, areaDestino: "TERAPIA" })).toBe(false);
  });
  it("centavos de redondeo no bloquean; el mensaje dice cuánto", () => {
    expect(debePagarAntes(0.004)).toBe(false);
    expect(debePagarAntes(150)).toBe(true);
    expect(mensajeCuentaUrgencias("EP-2026-0042", 1500.5)).toContain("$1,500.50");
  });
});
