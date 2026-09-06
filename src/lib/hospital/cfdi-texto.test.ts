import { describe, expect, it } from "vitest";
import { categoriaDe, nombreDePaciente, nombrePropio, normalizarDescripcion, partirNombre } from "./cfdi-texto";

describe("normalizarDescripcion()", () => {
  it("sube a mayúsculas, quita acentos y colapsa lo que no es alfanumérico", () => {
    expect(normalizarDescripcion("  Cefalotina 1 g   sol. iny. — ámpula ")).toBe("CEFALOTINA 1 G SOL INY AMPULA");
    expect(normalizarDescripcion("FARMACIA HOSPITALARIA 16")).toBe("FARMACIA HOSPITALARIA 16");
    expect(normalizarDescripcion(null)).toBe("");
  });
});

describe("nombreDePaciente()", () => {
  const casos: Array<[string, string | null]> = [
    ["Hospitalización px Rafael Jiménez Torres", "RAFAEL JIMENEZ TORRES"],
    ["Servicios hospitalarios PX Jessica Guadalupe Barranco Lima", "JESSICA GUADALUPE BARRANCO LIMA"],
    ["Cistoscopia, paciente Héctor Rogelio Aguilera Vázquez", "HECTOR ROGELIO AGUILERA VAZQUEZ"],
    ["Servicios oncológicos, paciente Juan Bernardino Ramirez Nava", "JUAN BERNARDINO RAMIREZ NAVA"],
    ["Estudio inmunohistoquímica, paciente Mercedes Montagner Berra.", "MERCEDES MONTAGNER BERRA"],
    ["NC EXCENDETE DE BIOPSIA (PX MARIA GUADALUPE TAMBURRINO VARGAS)", "MARIA GUADALUPE TAMBURRINO VARGAS"],
    ["Servicio de hospitalización PX Viridiana Marquez Palacios", "VIRIDIANA MARQUEZ PALACIOS"],
    ["Honorarios médicos px: Ana María de la Torre Ruiz", "ANA MARIA DE LA TORRE RUIZ"],
    // Los conceptos de las facturas a persona física son renglones de área,
    // no nombres: de ahí no sale ningún paciente.
    ["HOSPITALIZACION", null],
    ["FARMACIA HOSPITALARIA 16", null],
    ["RECUPERACION POSTQUIRURGICA", null],
    ["CENTRAL DE EQUIPOS Y ESTERILIZACION", null],
    ["PAQUETES", null],
    // «px» suelto o con un solo apellido no alcanza.
    ["Consulta px Juan", null],
  ];
  for (const [desc, esperado] of casos) {
    it(`«${desc.slice(0, 46)}» → ${esperado ?? "sin nombre"}`, () => {
      expect(nombreDePaciente(desc)).toBe(esperado);
    });
  }
});

describe("partirNombre()", () => {
  it("los dos últimos tokens son los apellidos", () => {
    expect(partirNombre("RAFAEL JIMENEZ TORRES")).toEqual({ nombre: "Rafael", apellidoPaterno: "Jimenez", apellidoMaterno: "Torres" });
    expect(partirNombre("JESSICA GUADALUPE BARRANCO LIMA")).toEqual({
      nombre: "Jessica Guadalupe",
      apellidoPaterno: "Barranco",
      apellidoMaterno: "Lima",
    });
  });

  it("las partículas se pegan al apellido que encabezan", () => {
    expect(partirNombre("ANA MARIA DE LA TORRE RUIZ")).toEqual({
      nombre: "Ana Maria",
      apellidoPaterno: "De la Torre",
      apellidoMaterno: "Ruiz",
    });
  });

  it("con dos palabras hay nombre y un solo apellido", () => {
    expect(partirNombre("MERCEDES MONTAGNER")).toEqual({ nombre: "Mercedes", apellidoPaterno: "Montagner", apellidoMaterno: null });
  });

  it("una sola palabra no da apellido (la factura no alcanza para un paciente)", () => {
    expect(partirNombre("MERCEDES")).toEqual({ nombre: "Mercedes", apellidoPaterno: "", apellidoMaterno: null });
  });
});

describe("nombrePropio()", () => {
  it("capitaliza, deja las partículas en minúscula y respeta las siglas", () => {
    expect(nombrePropio("PLAN SEGURO S.A. DE C.V.")).toBe("Plan Seguro S.A. de C.V.");
    expect(nombrePropio("RADIX MED SA DE CV")).toBe("Radix Med SA de CV");
    expect(nombrePropio("MARIA DE LOURDES GARCIA")).toBe("Maria de Lourdes Garcia");
  });
});

describe("categoriaDe()", () => {
  const casos: Array<[string, string]> = [
    ["HOSPITALIZACION", "HABITACION"],
    ["RECUPERACION POSTQUIRURGICA", "HABITACION"],
    ["QUIROFANO", "QUIROFANO"],
    ["URGENCIAS", "URGENCIAS"],
    ["FARMACIA HOSPITALARIA 16", "FARMACIA"],
    ["FARMACIA HOSPITALARIA 0", "FARMACIA"],
    ["CENTRAL DE EQUIPOS Y ESTERILIZACION", "MATERIAL"],
    ["PATOLOGIA", "ESTUDIO"],
    ["RAYOS X", "ESTUDIO"],
    ["LABORATORIO CLINICO", "ESTUDIO"],
    ["ENDOSCOPIA", "PROCEDIMIENTO"],
    ["PAQUETES", "PROCEDIMIENTO"],
    ["Honorarios médicos px Rafael Jiménez", "HONORARIO"],
    ["Renta de cistoscopio", "EQUIPO"],
    ["Servicios administrativos", "OTRO"],
  ];
  for (const [desc, esperada] of casos) {
    it(`«${desc}» → ${esperada}`, () => expect(categoriaDe(desc)).toBe(esperada));
  }
});
