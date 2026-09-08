import { describe, it, expect } from "vitest";
import { causaIsn, DIA_VENCIMIENTO_ISN_DEFAULT, periodoIsn } from "./periodo";
import type { Contexto } from "../rules";
import type { ResumenIsn } from "./types";

const CTX: Contexto = {
  regimen: "601",
  actividades: [],
  tipoPersona: "PM",
  fecha: "2026-08-01",
} as unknown as Contexto;

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
const NLE = { ...OAX, entidad: "NLE" as const, baseMensual: 100000, isn: 3000 };

describe("periodoIsn — una obligación POR ESTADO", () => {
  it("una empresa con sucursales debe a varios estados, cada uno con su fila", () => {
    const p = periodoIsn(2026, 8, resumen({ porEntidad: [OAX, NLE] }), CTX);
    expect(p.obligaciones.map((o) => o.entidad).sort()).toEqual(["NLE", "OAX"]);
    expect(p.totalConocido).toBe(9000);
    // Cada una con su propia fecha: son pagos a tesorerías distintas.
    expect(p.obligaciones.every((o) => o.fechaLimite instanceof Date)).toBe(true);
  });

  it("un estado sin tasa SIGUE siendo obligación, sin importe — no es cero", () => {
    const p = periodoIsn(2026, 8, resumen({
      porEntidad: [OAX, { ...OAX, entidad: "BCS", tasa: null, isn: null, baseMensual: 90000 }],
    }), CTX);
    expect(p.obligaciones).toHaveLength(2);
    const bcs = p.obligaciones.find((o) => o.entidad === "BCS")!;
    expect(bcs.importe).toBeNull();
    expect(bcs.baseMensual).toBe(90000);
    expect(p.sinTasa).toEqual(["BCS"]);
    // El total NO se infla con la entidad sin tasa.
    expect(p.totalConocido).toBe(6000);
  });

  it("sin día propio en el catálogo usa el default y lo DICE", () => {
    const p = periodoIsn(2026, 8, resumen({ porEntidad: [OAX] }), CTX);
    expect(p.obligaciones[0].vencimientoVerificado).toBe(false);
    expect(p.obligaciones[0].fechaLimite.getDate()).toBeGreaterThanOrEqual(DIA_VENCIMIENTO_ISN_DEFAULT);
  });

  it("arrastra que la tasa no está cotejada contra el texto de la ley", () => {
    const p = periodoIsn(2026, 8, resumen({ porEntidad: [OAX] }), CTX);
    expect(p.obligaciones[0].tasaVerificada).toBe(false);
  });

  it("conserva la nota del estado progresivo o con sobretasa", () => {
    const nota = "PROGRESIVO 2.4%–3.0% por tramos de nómina; 3.0% es el tope";
    const p = periodoIsn(2026, 8, resumen({ porEntidad: [{ ...OAX, entidad: "SIN", nota }] }), CTX);
    expect(p.obligaciones[0].nota).toBe(nota);
  });

  it("ordena por fecha y, a igual fecha, por monto", () => {
    const p = periodoIsn(2026, 8, resumen({ porEntidad: [NLE, OAX] }), CTX);
    expect(p.obligaciones[0].entidad).toBe("OAX"); // mismo día, mayor importe
  });

  it("sin nómina atribuible no hay obligación", () => {
    expect(causaIsn(periodoIsn(2026, 8, resumen(), CTX))).toBe(false);
  });

  it("arrastra la procedencia de la base y los empleados sin estado", () => {
    const p = periodoIsn(2026, 8, resumen({ porEntidad: [OAX], fuente: "estimado", empleadosSinEntidad: 3 }), CTX);
    expect(p.fuente).toBe("estimado");
    expect(p.empleadosSinEntidad).toBe(3);
  });
});
