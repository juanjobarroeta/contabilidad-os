import { describe, expect, it } from "vitest";
import { combinarNombresPorRfc } from "./contraparte-nombre";

// La decisión de PR: con qué nombre se viste un RFC extraído del estado de
// cuenta. El catálogo de clientes gana sobre las facturas; entre facturas gana
// la primera del arreglo (el caller las manda por fecha descendente).

describe("combinarNombresPorRfc", () => {
  it("resuelve desde las facturas cuando no hay cliente", () => {
    const m = combinarNombresPorRfc(
      [],
      [{ contraparteRfc: "HDM001017AS1", contraparteNombre: "HOME DEPOT MEXICO" }]
    );
    expect(m.get("HDM001017AS1")).toBe("HOME DEPOT MEXICO");
  });

  it("el catálogo de clientes gana sobre la factura", () => {
    const m = combinarNombresPorRfc(
      [{ rfc: "GEN120904917", razonSocial: "GUZA ENERGETICOS SA DE CV" }],
      [{ contraparteRfc: "GEN120904917", contraparteNombre: "GUZA ENERGETICOS" }]
    );
    expect(m.get("GEN120904917")).toBe("GUZA ENERGETICOS SA DE CV");
  });

  it("entre facturas gana la primera del arreglo (la más reciente)", () => {
    const m = combinarNombresPorRfc(
      [],
      [
        { contraparteRfc: "CCO8605231N4", contraparteNombre: "CADENA COMERCIAL OXXO" },
        { contraparteRfc: "CCO8605231N4", contraparteNombre: "OXXO VIEJO" },
      ]
    );
    expect(m.get("CCO8605231N4")).toBe("CADENA COMERCIAL OXXO");
  });

  it("normaliza el RFC a mayúsculas y recorta espacios", () => {
    const m = combinarNombresPorRfc(
      [{ rfc: " gen120904917 ", razonSocial: "  GUZA  " }],
      []
    );
    expect(m.get("GEN120904917")).toBe("GUZA");
  });

  it("no emite nada con nombre vacío o RFC nulo — la regla de la casa", () => {
    const m = combinarNombresPorRfc(
      [{ rfc: "AAA010101AAA", razonSocial: "   " }],
      [
        { contraparteRfc: null, contraparteNombre: "SIN RFC" },
        { contraparteRfc: "BBB020202BBB", contraparteNombre: null },
        { contraparteRfc: "CCC030303CCC", contraparteNombre: "  " },
      ]
    );
    expect(m.size).toBe(0);
  });
});
