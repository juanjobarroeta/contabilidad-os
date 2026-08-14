import { describe, it, expect } from "vitest";
import { parsePeriodos } from "./route";

// El parámetro `periodos` se teclea a mano para repescar meses concretos, así
// que la regla es NO ADIVINAR: lo que no parsea se ignora en silencio y la ruta
// falla con "ningún periodo válido" en vez de pedirle al SAT un rango inventado
// — que además quemaría cuota vitalicia.

describe("parsePeriodos", () => {
  it("lee la lista de los ocho meses roros de MARGOM", () => {
    expect(parsePeriodos("2022-01,2022-02,2022-03,2022-05,2022-06,2023-08,2024-01,2025-04")).toEqual([
      { year: 2022, month: 1 },
      { year: 2022, month: 2 },
      { year: 2022, month: 3 },
      { year: 2022, month: 5 },
      { year: 2022, month: 6 },
      { year: 2023, month: 8 },
      { year: 2024, month: 1 },
      { year: 2025, month: 4 },
    ]);
  });

  it("acepta mes de una cifra y tolera espacios", () => {
    expect(parsePeriodos(" 2025-4 , 2023-08 ")).toEqual([
      { year: 2025, month: 4 },
      { year: 2023, month: 8 },
    ]);
  });

  it("descarta lo que no es un periodo, sin adivinar", () => {
    expect(parsePeriodos("2025-13,2025-00,1999-05,abril,2025,,2025-4-1")).toEqual([]);
  });

  it("no repite un periodo pedido dos veces", () => {
    // Pedirlo dos veces gastaría dos solicitudes contra la misma cuota.
    expect(parsePeriodos("2025-04,2025-4,2025-04")).toEqual([{ year: 2025, month: 4 }]);
  });

  it("conserva el orden en que se pidieron", () => {
    expect(parsePeriodos("2025-04,2022-01")).toEqual([
      { year: 2025, month: 4 },
      { year: 2022, month: 1 },
    ]);
  });
});
