import { describe, it, expect } from "vitest";
import { causaIsn, periodoIsn } from "./periodo";
import type { ResumenIsn } from "./types";

function resumen(over: Partial<ResumenIsn> = {}): ResumenIsn {
  return {
    porEntidad: [],
    empleadosSinEntidad: 0,
    numEntidades: 0,
    isnTotal: 0,
    fuente: "payroll",
    ...over,
  } as ResumenIsn;
}

const OAX = {
  entidad: "OAX" as const,
  numEmpleados: 4,
  baseMensual: 200000,
  tasa: 0.03,
  isn: 6000,
  verificado: false,
};

describe("periodoIsn", () => {
  it("suma sólo las entidades con tasa conocida", () => {
    const p = periodoIsn(2026, 8, resumen({
      porEntidad: [
        OAX,
        // Un estado sin regla en el catálogo: su nómina existe, su tasa no.
        { entidad: "BCS", numEmpleados: 2, baseMensual: 90000, tasa: null, isn: null, verificado: false },
      ],
    }));
    expect(p.total).toBe(6000);
    expect(p.sinTasa).toEqual(["BCS"]);
    expect(p.porEntidad).toHaveLength(1);
  });

  it("un total incompleto NO se disfraza de completo", () => {
    // La entidad sin tasa no desaparece: sale aparte para que el contador la vea.
    const p = periodoIsn(2026, 8, resumen({
      porEntidad: [{ entidad: "BCS", numEmpleados: 2, baseMensual: 90000, tasa: null, isn: null, verificado: false }],
    }));
    expect(p.total).toBe(0);
    expect(p.sinTasa).toEqual(["BCS"]);
    expect(causaIsn(p)).toBe(true);
  });

  it("marca como aproximadas las entidades con progresivo o sobretasa", () => {
    const p = periodoIsn(2026, 8, resumen({
      porEntidad: [
        OAX,
        { ...OAX, entidad: "SIN", nota: "PROGRESIVO 2.4%–3.0% por tramos de nómina; 3.0% es el tope" },
      ],
    }));
    expect(p.aproximadas).toHaveLength(1);
    expect(p.aproximadas[0].entidad).toBe("SIN");
    expect(p.total).toBe(12000);
  });

  it("varias entidades: una empresa con sucursales debe a varios estados", () => {
    const p = periodoIsn(2026, 8, resumen({
      porEntidad: [OAX, { ...OAX, entidad: "NLE", isn: 3000, baseMensual: 100000 }],
    }));
    expect(p.total).toBe(9000);
    expect(p.porEntidad).toHaveLength(2);
  });

  it("sin nómina atribuible no hay obligación", () => {
    expect(causaIsn(periodoIsn(2026, 8, resumen()))).toBe(false);
  });

  it("dice que las tasas no están verificadas contra el texto de la ley", () => {
    expect(periodoIsn(2026, 8, resumen({ porEntidad: [OAX] })).todasSinVerificar).toBe(true);
    expect(
      periodoIsn(2026, 8, resumen({ porEntidad: [{ ...OAX, verificado: true }] })).todasSinVerificar,
    ).toBe(false);
  });

  it("vence el 17 del mes siguiente, recorrido a día hábil", () => {
    const p = periodoIsn(2026, 8, resumen({ porEntidad: [OAX] }));
    expect(p.periodo).toBe("2026-08");
    expect(p.fechaLimite.getMonth()).toBe(8); // septiembre (0-based)
    expect(p.fechaLimite.getDate()).toBeGreaterThanOrEqual(17);
  });

  it("arrastra la procedencia de la base y los empleados sin entidad", () => {
    const p = periodoIsn(2026, 8, resumen({ porEntidad: [OAX], fuente: "estimado", empleadosSinEntidad: 3 }));
    expect(p.fuente).toBe("estimado");
    expect(p.empleadosSinEntidad).toBe(3);
  });
});
