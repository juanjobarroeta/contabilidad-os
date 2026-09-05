import { describe, expect, it } from "vitest";
import { exigeLibroControl, exigeRecetaEspecial, grupoControlPorNombre } from "./controlados";

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
