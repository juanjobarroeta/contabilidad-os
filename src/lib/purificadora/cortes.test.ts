import { describe, it, expect } from "vitest";
import { corteUpdateSchema } from "./cortes";
import { CATEGORIAS_GASTO, descripcionGasto } from "./categorias";

// Regresión: el corte del día rechazaba con 400 los gastos de ESTACIONAMIENTO
// (el enum creció y esta lista se quedó atrás), y descartaba en silencio los
// gastos sin descripción. Cualquiera de las dos cosas le costaba a Minerva la
// captura completa del día.
describe("corteUpdateSchema — gastos", () => {
  const base = { rutas: [], empresas: [], gastos: [] };

  it("acepta TODAS las categorías del enum de Prisma", () => {
    for (const categoria of CATEGORIAS_GASTO) {
      const parsed = corteUpdateSchema.safeParse({
        ...base,
        gastos: [{ categoria, descripcion: "prueba", monto: 25 }],
      });
      expect(parsed.success, `categoría rechazada: ${categoria}`).toBe(true);
    }
  });

  it("acepta un gasto sin descripción y lo nombra por su categoría", () => {
    const parsed = corteUpdateSchema.safeParse({
      ...base,
      gastos: [
        { categoria: "COMBUSTIBLE", descripcion: "", monto: 200 },
        { categoria: "ESTACIONAMIENTO", monto: 25 },
      ],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.gastos).toHaveLength(2);
    expect(parsed.data.gastos[0].descripcion).toBe("Combustible");
    expect(parsed.data.gastos[1].descripcion).toBe("Estacionamiento");
  });

  it("respeta la descripción cuando sí viene", () => {
    const parsed = corteUpdateSchema.safeParse({
      ...base,
      gastos: [{ categoria: "COMBUSTIBLE", descripcion: "Gasolina camioneta", monto: 200 }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.gastos[0].descripcion).toBe("Gasolina camioneta");
  });

  it("sigue rechazando montos no positivos", () => {
    const parsed = corteUpdateSchema.safeParse({
      ...base,
      gastos: [{ categoria: "OTRO", descripcion: "x", monto: 0 }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("descripcionGasto", () => {
  it("usa la etiqueta de la categoría cuando el texto viene vacío o en blanco", () => {
    expect(descripcionGasto("", "SUELDOS")).toBe("Sueldos");
    expect(descripcionGasto("   ", "AGUA_CRUDA")).toBe("Agua cruda");
    expect(descripcionGasto(null, "ESTACIONAMIENTO")).toBe("Estacionamiento");
  });

  it("recorta el texto capturado", () => {
    expect(descripcionGasto("  Pipa de agua  ", "AGUA_CRUDA")).toBe("Pipa de agua");
  });
});
