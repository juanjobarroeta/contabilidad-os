import { describe, it, expect } from "vitest";
import {
  contradiceAlSat,
  diceCancelado,
  diceEnProceso,
  estadoDeCancelacion,
} from "./cancelacion-estado";

describe("diceCancelado", () => {
  it("«Cancelable con aceptación» NO es cancelado", () => {
    // Era la mina: `startsWith("cancel")` daba true y borrábamos del mes un
    // comprobante que el SAT sigue contando.
    expect(diceCancelado("Cancelable con aceptación")).toBe(false);
    expect(diceCancelado("Cancelable sin aceptación")).toBe(false);
  });

  it("«Cancelado con/sin aceptación» sí lo es", () => {
    expect(diceCancelado("Cancelado con aceptación")).toBe(true);
    expect(diceCancelado("Cancelado sin aceptación")).toBe(true);
    expect(diceCancelado("Cancelado")).toBe(true);
  });

  it("acepta el código numérico del SAT", () => {
    expect(diceCancelado("0")).toBe(true);
    expect(diceCancelado("1")).toBe(false);
  });

  it("vacío o nulo no afirma nada", () => {
    expect(diceCancelado(null)).toBe(false);
    expect(diceCancelado("")).toBe(false);
    expect(diceCancelado("   ")).toBe(false);
  });
});

describe("estadoDeCancelacion", () => {
  it("el caso de Juan: vigente con el trámite en proceso", () => {
    expect(
      estadoDeCancelacion({ estado: "Vigente", estatusCancelacion: "En proceso" }),
    ).toBe("en_proceso");
  });

  it("vigente sin trámite abierto", () => {
    expect(estadoDeCancelacion({ estado: "Vigente", estatusCancelacion: "Cancelable con aceptación" })).toBe("vigente");
    expect(estadoDeCancelacion({ estado: "Vigente", estatusCancelacion: null })).toBe("vigente");
  });

  it("cancelado de verdad", () => {
    expect(estadoDeCancelacion({ estado: "Cancelado", estatusCancelacion: "Cancelado con aceptación" })).toBe("cancelado");
  });

  it("«No Encontrado» o vacío: desconocido, nunca cancelado", () => {
    expect(estadoDeCancelacion({ estado: "No Encontrado" })).toBe("desconocido");
    expect(estadoDeCancelacion({ estado: null })).toBe("desconocido");
  });

  it("el Estado manda sobre el estatus del trámite", () => {
    // Un trámite «en proceso» sobre un comprobante que el SAT ya dio por
    // cancelado: manda el comprobante.
    expect(estadoDeCancelacion({ estado: "Cancelado", estatusCancelacion: "En proceso" })).toBe("cancelado");
  });
});

describe("diceEnProceso", () => {
  it("reconoce el trámite abierto", () => {
    expect(diceEnProceso("En proceso")).toBe(true);
    expect(diceEnProceso("EN PROCESO DE CANCELACION")).toBe(true);
    expect(diceEnProceso("Cancelable con aceptación")).toBe(false);
    expect(diceEnProceso(null)).toBe(false);
  });
});

describe("contradiceAlSat", () => {
  it("cancelada aquí y vigente en el SAT: contradicción", () => {
    expect(contradiceAlSat({ status: "CANCELLED" }, "vigente")).toBe(true);
    expect(contradiceAlSat({ status: "CANCELLED" }, "en_proceso")).toBe(true);
  });

  it("sin contradicción cuando coinciden o no sabemos", () => {
    expect(contradiceAlSat({ status: "CANCELLED" }, "cancelado")).toBe(false);
    expect(contradiceAlSat({ status: "CANCELLED" }, "desconocido")).toBe(false);
    expect(contradiceAlSat({ status: "STAMPED" }, "vigente")).toBe(false);
  });
});
