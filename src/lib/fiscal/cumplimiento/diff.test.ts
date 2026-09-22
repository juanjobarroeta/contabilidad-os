import { describe, it, expect } from "vitest";
import { claveObligacion, hashContenido, evaluarCambioCumplimiento } from "./diff";
import type { CsfResult } from "./types";

const csf = (obligaciones: string[], extra: Partial<CsfResult["perfil"]> = {}): CsfResult => ({
  tipo: "CSF",
  perfil: { rfc: "ABC120101AAA", regimenes: ["601"], obligaciones, codigoPostal: "72810", estatusPadron: "ACTIVO", ...extra },
  fetchedAt: "2026-09-22T00:00:00Z",
});

// Lo que Syntage guardaba y lo que la CSF leída por Claude devuelve para la MISMA constancia.
const SYNTAGE = ["Pago definitivo mensual de IVA.", "Entero de retenciones mensuales de ISR por sueldos y salarios", "Declaración anual de ISR del ejercicio Personas morales."];
const CLAUDE = ["Declaración anual de ISR del ejercicio Personas morales", "Entero de retenciones mensuales de ISR por sueldos y salarios", "Pago definitivo mensual de IVA"];

describe("obligaciones entre proveedores", () => {
  it("la clave ignora punto final, acentos, mayúsculas y espacios", () => {
    expect(claveObligacion("Pago definitivo mensual de IVA.")).toBe(claveObligacion("pago  definitivo mensual de iva"));
    expect(claveObligacion("Declaración anual de ISR.")).toBe("declaracion anual de isr");
  });

  it("mismo contenido con distinta puntuación → mismo hash y sin hallazgo", () => {
    expect(hashContenido(csf(SYNTAGE))).toBe(hashContenido(csf(CLAUDE)));
    expect(evaluarCambioCumplimiento(csf(CLAUDE), csf(SYNTAGE))).toEqual([]);
  });

  it("una obligación de verdad nueva sí abre hallazgo, con el texto original", () => {
    const h = evaluarCambioCumplimiento(csf([...CLAUDE, "Pago de ISAN mensual"]), csf(SYNTAGE));
    expect(h).toHaveLength(1);
    expect(h[0].checkClave).toBe("cumplimiento.csf.obligaciones");
    expect(h[0].mensaje).toContain("(+Pago de ISAN mensual)");
    expect(h[0].mensaje).not.toContain("(-");
  });

  it("el CP y el régimen siguen comparándose tal cual", () => {
    expect(hashContenido(csf(CLAUDE, { codigoPostal: "72000" }))).not.toBe(hashContenido(csf(CLAUDE)));
    expect(evaluarCambioCumplimiento(csf(CLAUDE, { regimenes: ["626"] }), csf(SYNTAGE)).map((h) => h.checkClave)).toEqual(["cumplimiento.csf.regimen"]);
  });
});
