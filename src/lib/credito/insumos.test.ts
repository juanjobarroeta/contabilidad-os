import { describe, expect, it } from "vitest";
import { SIN_TRASPASOS_INTERNOS } from "./insumos";

// ─────────────────────────────────────────────────────────────────────────────
// Regresión de un bug real: el flujo bancario del score salió en $0 de entradas
// para una clienta que sí tenía depósitos. La causa fue escribir el filtro como
// `NOT: { notes: "INTERNAL_TRANSFER" }`, que en SQL descarta también las filas
// con `notes` NULL (lógica de tres valores) — es decir, TODOS los movimientos
// sin categorizar, que son la mayoría. Verificado contra Prisma: con NOT sólo
// sobreviven las filas con nota no nula; con el OR explícito, las correctas.
//
// Este test fija la forma del filtro para que nadie lo "simplifique" de vuelta.
// ─────────────────────────────────────────────────────────────────────────────

const ramas = (SIN_TRASPASOS_INTERNOS.OR ?? []) as Array<Record<string, unknown>>;

describe("SIN_TRASPASOS_INTERNOS", () => {
  it("acepta explícitamente las filas con notes NULL (sin categorizar)", () => {
    expect(ramas.some((r) => r.notes === null)).toBe(true);
  });

  it("excluye únicamente INTERNAL_TRANSFER", () => {
    const negacion = ramas.find((r) => typeof r.notes === "object" && r.notes !== null);
    expect(negacion?.notes).toEqual({ not: "INTERNAL_TRANSFER" });
  });

  it("NO usa la forma NOT, que descartaría los movimientos sin categorizar", () => {
    expect(SIN_TRASPASOS_INTERNOS).not.toHaveProperty("NOT");
  });

  /** Espejo de la semántica SQL: así se comporta cada forma ante notes NULL. */
  it("documenta por qué NOT falla: la comparación con NULL no es TRUE", () => {
    const filas = [
      { notes: null, monto: 87_000 },
      { notes: null, monto: -134_000 },
      { notes: "PENDING_MONTHLY_CFDI", monto: -2_354 },
      { notes: "INTERNAL_TRANSFER", monto: 5_000 },
    ];
    // `NOT (notes = 'X')` con notes NULL → NULL → la fila NO pasa el WHERE.
    const conNot = filas.filter((f) => (f.notes == null ? false : f.notes !== "INTERNAL_TRANSFER"));
    expect(conNot.map((f) => f.monto)).toEqual([-2_354]); // sólo la comisión: entradas $0

    // Con el OR explícito entran las no categorizadas y se va sólo el traspaso.
    const conOr = filas.filter((f) => f.notes == null || f.notes !== "INTERNAL_TRANSFER");
    expect(conOr.map((f) => f.monto)).toEqual([87_000, -134_000, -2_354]);
  });
});
