import { describe, it, expect } from "vitest";
import { pareceDevolucionSuelta, type CandidataDevolucion } from "./devoluciones-repo";

const mov = (over: Partial<CandidataDevolucion> = {}): CandidataDevolucion => ({
  id: "t1",
  bankAccountId: "ba1",
  fecha: new Date("2026-09-10"),
  monto: 22732.5,
  descripcion: "SPEI DEVUELTO",
  referencia: "CLAVE123",
  status: "UNMATCHED",
  devolucionDeId: null,
  devolucionPor: null,
  ...over,
});

describe("pareceDevolucionSuelta()", () => {
  it("ya vinculado o ya conciliado: no se le busca origen", () => {
    expect(pareceDevolucionSuelta(mov())).toBe(true);
    expect(pareceDevolucionSuelta(mov({ devolucionDeId: "otro" }))).toBe(false);
    expect(pareceDevolucionSuelta(mov({ devolucionPor: { id: "otro" } }))).toBe(false);
    expect(pareceDevolucionSuelta(mov({ status: "MATCHED" }))).toBe(false);
  });

  // La lista mira sólo los que lo dicen (una consulta por renglón sale cara);
  // la mesa mira UNO y no puede exigirlo: un depósito equivocado que regresa no
  // trae la palabra «devuelto» en ninguna parte.
  it("la descripción se exige por costo, no por criterio", () => {
    const sinPalabra = mov({ descripcion: "TRASPASO A CUENTA DE TERCEROS" });
    expect(pareceDevolucionSuelta(sinPalabra)).toBe(false);
    expect(pareceDevolucionSuelta(sinPalabra, { exigirDescripcion: false })).toBe(true);
    // Lo ya vinculado sigue fuera aunque se relaje la descripción.
    expect(pareceDevolucionSuelta(mov({ descripcion: "X", devolucionDeId: "p" }), { exigirDescripcion: false })).toBe(false);
  });
});
