import { describe, it, expect } from "vitest";
import { clasificarIngreso } from "./otros-ingresos";

// Descripciones REALES de los CFDIs de Margom (clave 8014xx del SAT). La clave
// no distingue entre las tres cosas — sólo el texto lo hace.
describe("clasificarIngreso()", () => {
  it("bonos del distribuidor: front end", () => {
    expect(clasificarIngreso("Bono Flotillas")).toBe("bonos");
    expect(clasificarIngreso("BONO Incremental MAYO 2024 Grupo ASTURCAR")).toBe("bonos");
    expect(clasificarIngreso("INCENTIVOS CREDITO 060622 AL 120622")).toBe("bonos");
    expect(clasificarIngreso("Apoyo publicitario 2026")).toBe("bonos");
  });

  it("uso de instalaciones que pagan las aseguradoras: back end", () => {
    expect(clasificarIngreso("Pago de UDI DICIEMBRE 2025 GNP, Quálitas e INBURSA Proceso N")).toBe(
      "uso_instalaciones"
    );
    expect(clasificarIngreso("UDIS MARZO 2026")).toBe("uso_instalaciones");
    expect(clasificarIngreso("Uso de instalaciones hojalatería")).toBe("uso_instalaciones");
  });

  it("lo que no empata NO se reparte a ojo: cae en otros, a la vista", () => {
    expect(clasificarIngreso("Reembolso de gastos por hospedaje CANCUN evento CANACAR")).toBe("otros");
    expect(clasificarIngreso("SERVICIO DE GESTION")).toBe("otros");
    expect(clasificarIngreso(null)).toBe("otros");
    expect(clasificarIngreso("")).toBe("otros");
  });

  it("«UDI» sólo como palabra, no dentro de otra", () => {
    // «cuidado», «estudio»… no deben leerse como uso de instalaciones.
    expect(clasificarIngreso("Servicio de cuidado de unidades")).toBe("otros");
    expect(clasificarIngreso("Estudio de mercado")).toBe("otros");
  });

  it("el UDI gana sobre el bono cuando el texto trae los dos", () => {
    // El concepto específico manda: es dinero de la aseguradora por el taller.
    expect(clasificarIngreso("Bono por uso de instalaciones GNP")).toBe("uso_instalaciones");
  });
});
