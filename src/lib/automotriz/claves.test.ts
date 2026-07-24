import { describe, it, expect } from "vitest";
import { parseAnexo15Claves, modeloLimpio } from "./claves";

// Fragmento REAL del Anexo 15 RMF 2026 (DOF 28-dic-2025), tal como sale del
// extractor de texto del PDF: encabezados de página, "Versión NN" sólo en la
// primera versión, claves alfanuméricas y descripciones partidas en renglones.
const TEXTO = `C. Código de claves vehiculares.
1. Registradas.
Clave Empresa 01 : Stellantis México, S.A. de C.V. (antes FCA México, S.A. de C.V.)
Modelo 31 : Ram 1500 (nacional)
1013114 Versión 14 : Ram 1500 Crew Cab, aut., 3.0 lts., turbo, 6 cil.
Modelo 02 : Ram 4000
2010224 Versión 24 : Ram 4000, Regular Cab, aut., 6.4 lts., 8 cil. (nacional)
2010225 25 : Ram 4000, Regular Cab, aut., 6.7 lts., turbo diesel, 6 cil. (nacional)
Modelo 18 : RAM 5500 (nacional)

-- 1 of 14 --

Domingo 28 de diciembre de 2025 DIARIO OFICIAL
2011801 Versión 01 : Ram 5500, Regular Cab, aut., 6.4 lts., 8 cil.
Clave Empresa 05 : Volkswagen de México, S.A. de C.V.
Modelo 59 : Porsche 911 2 puertas
00559AR Versión AR : Porsche 911 Turbo S, 3.6 lts., PDK, Tracción Integral, gasolina
Modelo 07 : Seat Híbrido 4 puertas
6050704 Versión 04 : Cupra Formentor, 1.5 lts., TSI, MHEV Mild Hybrid DSG, Tracción Frontal,
gasolina
Clave Empresa 60 : Giant Motors Latinoamérica, S.A. de C.V.
Modelo 04 : Pick Up JAC Híbrido 4 puertas Marca GML (nacional)
6600401 Versión 01 : Frison T9 Hibrida, 1.5 lts., Turbo, 4x4
`;

describe("parseAnexo15Claves()", () => {
  const entries = parseAnexo15Claves(TEXTO);

  it("extrae todas las claves del fragmento", () => {
    expect(entries.map((e) => e.clave)).toEqual([
      "1013114", "2010224", "2010225", "2011801", "00559AR", "6050704", "6600401",
    ]);
  });

  it("asigna empresa y modelo vigentes a cada clave", () => {
    const ram4000 = entries.find((e) => e.clave === "2010225")!;
    expect(ram4000.empresa).toContain("Stellantis");
    expect(ram4000.modelo).toBe("Ram 4000");
    expect(ram4000.version).toContain("turbo diesel");
  });

  it("cruza el corte de página sin perder el contexto (RAM 5500)", () => {
    const ram5500 = entries.find((e) => e.clave === "2011801")!;
    expect(ram5500.modelo).toBe("RAM 5500 (nacional)");
    expect(ram5500.empresa).toContain("Stellantis");
  });

  it("acepta claves alfanuméricas (Porsche 00559AR)", () => {
    const porsche = entries.find((e) => e.clave === "00559AR")!;
    expect(porsche.version).toContain("911 Turbo S");
  });

  it("pega renglones de continuación a la descripción (Cupra … gasolina)", () => {
    const cupra = entries.find((e) => e.clave === "6050704")!;
    expect(cupra.version).toMatch(/Tracción Frontal, gasolina$/);
  });

  it("captura la entrada JAC/GML", () => {
    const jac = entries.find((e) => e.clave === "6600401")!;
    expect(jac.empresa).toContain("Giant Motors");
    expect(jac.modelo).toContain("JAC");
    expect(jac.version).toContain("Frison T9");
  });
});

describe("modeloLimpio()", () => {
  it("quita (nacional)/(importado) y 'Marca XXX'", () => {
    expect(modeloLimpio("Pick Up JAC Híbrido 4 puertas Marca GML (nacional)")).toBe(
      "Pick Up JAC Híbrido 4 puertas"
    );
    expect(modeloLimpio("Explorer 4 puertas (importado)")).toBe("Explorer 4 puertas");
  });
});
