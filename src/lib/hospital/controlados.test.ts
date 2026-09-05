import { describe, expect, it } from "vitest";
import {
  banderasControl,
  exigeLibroControl,
  exigeRecetaEspecial,
  grupoControlPorNombre,
  nombreReceta,
  sustanciaControladaPorNombre,
} from "./controlados";

describe("grupoControlPorNombre", () => {
  it("etiqueta por sustancia activa aunque venga con sal y presentación", () => {
    expect(grupoControlPorNombre("Midazolam 5 mg sol. iny.")).toBe("III");
    expect(grupoControlPorNombre("MIDAZOLAM CLORHIDRATO AMPOLLETA 15MG/3ML")).toBe("III");
    expect(grupoControlPorNombre("Fentanilo citrato 0.5 mg/10 ml")).toBe("I");
    expect(grupoControlPorNombre("METILFENIDATO 10 MG TAB")).toBe("II");
  });

  it("no etiqueta lo que no está en la lista ni por parecido", () => {
    expect(grupoControlPorNombre("Propofol 200 mg")).toBeNull();
    expect(grupoControlPorNombre("Ketorolaco 30 mg")).toBeNull();
    expect(grupoControlPorNombre("Solución Hartmann 1000 ml")).toBeNull();
    expect(grupoControlPorNombre("")).toBeNull();
    expect(grupoControlPorNombre(null)).toBeNull();
  });

  it("sabe qué grupos exigen libro y receta especial", () => {
    expect(exigeLibroControl("III")).toBe(true);
    expect(exigeLibroControl("IV")).toBe(false);
    expect(exigeRecetaEspecial("I")).toBe(true);
    expect(exigeRecetaEspecial("III")).toBe(false);
    expect(exigeRecetaEspecial(null)).toBe(false);
  });
});

describe("sustanciaControladaPorNombre", () => {
  it("devuelve la sustancia con la que se etiqueta el insumo, canónica y capitalizada", () => {
    expect(sustanciaControladaPorNombre("MIDAZOLAM CLORHIDRATO 15MG/3ML")).toEqual({ grupo: "III", sustancia: "Midazolam" });
    expect(sustanciaControladaPorNombre("FENTANIL 0.5 MG/10 ML")).toEqual({ grupo: "I", sustancia: "Fentanilo" });
    expect(sustanciaControladaPorNombre("Petidina 100 mg")).toEqual({ grupo: "I", sustancia: "Meperidina" });
    expect(sustanciaControladaPorNombre("Ketorolaco 30 mg")).toBeNull();
  });

  it("banderas y nombre de la receta por grupo", () => {
    expect(banderasControl("I")).toEqual({ exigeLibroControl: true, exigeRecetaEspecial: true });
    expect(banderasControl("III")).toEqual({ exigeLibroControl: true, exigeRecetaEspecial: false });
    expect(banderasControl(null)).toEqual({ exigeLibroControl: false, exigeRecetaEspecial: false });
    expect(nombreReceta("II")).toBe("receta especial con código de barras");
    expect(nombreReceta("III")).toBe("receta ordinaria retenida");
    expect(nombreReceta("IV")).toBe("receta");
  });
});
