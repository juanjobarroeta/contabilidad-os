import { describe, it, expect } from "vitest";
import { decidirEscritura, mismoValor } from "./hechos";

const vigente = (extra: Partial<Parameters<typeof decidirEscritura>[0] & object> = {}) => ({
  valor: "Banorte 7788",
  verificado: false,
  fuente: "motor" as const,
  evidencia: ["tx_1"],
  ...extra,
});

describe("mismoValor", () => {
  it("no distingue el orden de las claves: si no, cada corrida reabriría el mismo hecho", () => {
    expect(mismoValor({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(mismoValor({ a: 1, b: 2 }, { a: 1, b: 3 })).toBe(false);
  });

  it("compara anidado y distingue null de ausente", () => {
    expect(mismoValor({ x: { y: [1, 2] } }, { x: { y: [1, 2] } })).toBe(true);
    expect(mismoValor({ x: { y: [1, 2] } }, { x: { y: [2, 1] } })).toBe(false);
    expect(mismoValor(null, undefined)).toBe(true);
  });
});

describe("decidirEscritura", () => {
  it("sin nada previo, se crea", () => {
    expect(decidirEscritura(null, { valor: "x", fuente: "motor" }).accion).toBe("crear");
  });

  it("mismo valor y misma evidencia: no se escribe nada", () => {
    const d = decidirEscritura(vigente(), { valor: "Banorte 7788", fuente: "motor", evidencia: ["tx_1"] });
    expect(d.accion).toBe("ignorar");
  });

  it("mismo valor con evidencia nueva: el hecho se refuerza, no se duplica", () => {
    const d = decidirEscritura(vigente(), { valor: "Banorte 7788", fuente: "motor", evidencia: ["tx_2"] });
    expect(d.accion).toBe("enriquecer");
  });

  it("valor distinto: se cierra el anterior y se abre otro, nunca se sobreescribe", () => {
    const d = decidirEscritura(vigente(), { valor: "Banorte 9900", fuente: "motor" });
    expect(d.accion).toBe("reemplazar");
    expect(d.motivo).toContain("cierra");
  });

  it("lo que una persona verificó NO lo pisa el motor", () => {
    const d = decidirEscritura(vigente({ verificado: true, fuente: "usuario" }), {
      valor: "Banorte 9900",
      fuente: "motor",
    });
    expect(d.accion).toBe("ignorar");
    expect(d.motivo).toContain("verificó");
  });

  it("lo que una persona verificó TAMPOCO lo pisa el agente", () => {
    const d = decidirEscritura(vigente({ verificado: true, fuente: "usuario" }), {
      valor: "Banorte 9900",
      fuente: "agente",
    });
    expect(d.accion).toBe("ignorar");
  });

  it("una persona SÍ puede corregir lo que otra persona verificó", () => {
    const d = decidirEscritura(vigente({ verificado: true, fuente: "usuario" }), {
      valor: "Banorte 9900",
      fuente: "usuario",
    });
    expect(d.accion).toBe("reemplazar");
  });

  it("un hecho verificado que llega IGUAL no se bloquea: se le suma la evidencia", () => {
    const d = decidirEscritura(vigente({ verificado: true, fuente: "usuario" }), {
      valor: "Banorte 7788",
      fuente: "motor",
      evidencia: ["tx_9"],
    });
    expect(d.accion).toBe("enriquecer");
  });
});
