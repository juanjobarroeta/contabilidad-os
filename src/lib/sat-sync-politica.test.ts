import { describe, expect, it } from "vitest";
import { pedirMesCerrado, finDeMes, DIAS_PASADA_FINAL } from "./sat-sync-politica";

const completo = (tipo: string, creada: Date, status = "FINISHED") => ({
  tipo, status, desde: new Date(2026, 8, 1), hasta: finDeMes(2026, 9), createdAt: creada,
});

describe("pedirMesCerrado (septiembre 2026)", () => {
  const dia = (d: number, mes = 10) => new Date(2026, mes - 1, d, 12);

  it("sin pasada tras el cierre: pide (aunque durante el mes se haya pedido «del 1 a ayer»)", () => {
    const durante = { tipo: "EMITIDOS", status: "FINISHED", desde: new Date(2026, 8, 1), hasta: new Date(2026, 8, 29, 23, 59, 59), createdAt: new Date(2026, 8, 30) };
    expect(pedirMesCerrado(2026, 9, [durante], dia(1)).pedir).toBe(true);
  });

  it("con la primera pasada hecha y antes del día final: NO repite el mismo rango (cuota 5002)", () => {
    const r = pedirMesCerrado(2026, 9, [completo("EMITIDOS", dia(1)), completo("RECIBIDOS", dia(1))], dia(3));
    expect(r.pedir).toBe(false);
  });

  it(`pasados ${DIAS_PASADA_FINAL} días hace UNA pasada final, y después ya no`, () => {
    const primera = [completo("EMITIDOS", dia(1)), completo("RECIBIDOS", dia(1))];
    expect(pedirMesCerrado(2026, 9, primera, dia(6)).pedir).toBe(true);
    const conFinal = [...primera, completo("EMITIDOS", dia(6)), completo("RECIBIDOS", dia(6))];
    expect(pedirMesCerrado(2026, 9, conFinal, dia(20)).pedir).toBe(false);
  });

  it("una solicitud rechazada no cuenta como pasada", () => {
    const r = pedirMesCerrado(2026, 9, [completo("EMITIDOS", dia(1), "FAILED"), completo("RECIBIDOS", dia(1))], dia(2));
    expect(r.pedir).toBe(true);
  });
});

describe("pedirMesCerrado con la cuota quemada", () => {
  it("un lado con 5002 registrado para el mes completo no se vuelve a pedir", () => {
    const dia = (d: number) => new Date(2026, 9, d, 12);
    const quemado = { tipo: "EMITIDOS", status: "FAILED", errorMessage: "emitidos: … (código 5002)", desde: new Date(2026, 8, 1), hasta: finDeMes(2026, 9), createdAt: dia(1) };
    const recibidos = { tipo: "RECIBIDOS", status: "FINISHED", desde: new Date(2026, 8, 1), hasta: finDeMes(2026, 9), createdAt: dia(1) };
    expect(pedirMesCerrado(2026, 9, [quemado, recibidos], dia(2)).pedir).toBe(false);
  });
});
