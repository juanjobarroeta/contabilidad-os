import { describe, it, expect } from "vitest";
import { debeSuspender } from "./suspension";

describe("debeSuspender", () => {
  it("nunca suspende con el kill-switch apagado", () => {
    expect(debeSuspender({ suscripcionActiva: false, esOperador: false, habilitado: false })).toBe(false);
  });
  it("nunca suspende al operador", () => {
    expect(debeSuspender({ suscripcionActiva: false, esOperador: true, habilitado: true })).toBe(false);
  });
  it("no suspende si la suscripción está activa", () => {
    expect(debeSuspender({ suscripcionActiva: true, esOperador: false, habilitado: true })).toBe(false);
  });
  it("suspende: habilitado + no operador + suscripción inactiva", () => {
    expect(debeSuspender({ suscripcionActiva: false, esOperador: false, habilitado: true })).toBe(true);
  });
});
