import { describe, it, expect } from "vitest";
import { evaluarCierreEjercicio, MESES_EJERCICIO, type PeriodoResumen } from "./ejercicio";

const p = (
  month: number,
  status: PeriodoResumen["status"],
  entriesCount = 10
): PeriodoResumen => ({ month, status, entriesCount });

/** Un ejercicio completo y listo: 12 meses posteados + el mes 13 de cierre. */
const ejercicioCompleto = (): PeriodoResumen[] => [
  ...Array.from({ length: 12 }, (_, i) => p(i + 1, "POSTED")),
  p(13, "POSTED", 4),
];

describe("MESES_EJERCICIO", () => {
  it("cubre los 12 meses más el mes 13 del asiento de cierre", () => {
    expect(MESES_EJERCICIO).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });
});

describe("evaluarCierreEjercicio", () => {
  it("deja cerrar un ejercicio completo", () => {
    const e = evaluarCierreEjercicio(ejercicioCompleto());
    expect(e).toMatchObject({
      puedeCerrar: true,
      yaCerrado: false,
      mesesEnBorrador: [],
      faltaCierre: false,
      motivo: null,
    });
  });

  it("bloquea si un mes con asientos sigue en borrador, y los nombra en orden", () => {
    const periodos = ejercicioCompleto();
    periodos[6] = p(7, "DRAFT");
    periodos[2] = p(3, "DRAFT");
    const e = evaluarCierreEjercicio(periodos);
    expect(e.puedeCerrar).toBe(false);
    expect(e.mesesEnBorrador).toEqual([3, 7]);
    expect(e.motivo).toContain("3, 7");
  });

  it("un mes en borrador y VACÍO no estorba (simplemente no hubo operaciones)", () => {
    const periodos = ejercicioCompleto();
    periodos[7] = p(8, "DRAFT", 0);
    const e = evaluarCierreEjercicio(periodos);
    expect(e.mesesEnBorrador).toEqual([]);
    expect(e.puedeCerrar).toBe(true);
  });

  it("bloquea si falta el asiento de cierre del mes 13", () => {
    const sinCierre = ejercicioCompleto().filter((x) => x.month !== 13);
    const e = evaluarCierreEjercicio(sinCierre);
    expect(e.puedeCerrar).toBe(false);
    expect(e.faltaCierre).toBe(true);
    expect(e.motivo).toContain("mes 13");
  });

  it("un mes 13 existente pero VACÍO cuenta como cierre faltante", () => {
    const periodos = [...ejercicioCompleto().filter((x) => x.month !== 13), p(13, "DRAFT", 0)];
    expect(evaluarCierreEjercicio(periodos).faltaCierre).toBe(true);
  });

  it("reconoce un ejercicio ya cerrado y no ofrece volver a cerrarlo", () => {
    const cerrado = ejercicioCompleto().map((x) => ({ ...x, status: "CLOSED" as const }));
    const e = evaluarCierreEjercicio(cerrado);
    expect(e.yaCerrado).toBe(true);
    expect(e.puedeCerrar).toBe(false);
    expect(e.motivo).toContain("ya está cerrado");
  });

  it("los periodos vacíos creados por el candado no fingen un ejercicio cerrado", () => {
    // Al cerrar se crean filas CLOSED vacías para los meses sin operaciones;
    // un ejercicio SIN nada posteado no debe leerse como «ya cerrado».
    const soloVacios = MESES_EJERCICIO.map((m) => p(m, "CLOSED", 0));
    expect(evaluarCierreEjercicio(soloVacios).yaCerrado).toBe(false);
  });

  it("un ejercicio sin nada no se puede cerrar (falta el cierre)", () => {
    const e = evaluarCierreEjercicio([]);
    expect(e.puedeCerrar).toBe(false);
    expect(e.yaCerrado).toBe(false);
    expect(e.faltaCierre).toBe(true);
  });

  it("los meses en borrador se reportan antes que el cierre faltante", () => {
    // Ambos problemas a la vez: el mensaje debe guiar al PRIMER paso.
    const periodos = [p(1, "POSTED"), p(2, "DRAFT")];
    const e = evaluarCierreEjercicio(periodos);
    expect(e.mesesEnBorrador).toEqual([2]);
    expect(e.faltaCierre).toBe(true);
    expect(e.motivo).toContain("Faltan meses por cerrar");
  });
});
