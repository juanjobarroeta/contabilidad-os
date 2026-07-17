import { describe, it, expect } from "vitest";
import { resolverFechaCfdi } from "./fecha-cfdi";

// "Ahora" fijo para los casos: 17-jul-2026 12:00 hora del centro (UTC-6).
const AHORA = new Date("2026-07-17T12:00:00-06:00");

describe("resolverFechaCfdi", () => {
  it("hoy → sin fecha explícita (Facturapi fecha con el momento del timbrado)", () => {
    expect(resolverFechaCfdi("2026-07-17", AHORA)).toEqual({});
  });

  it("ayer → 23:59 hora del centro de ese día (lo más tarde posible)", () => {
    const { fechaCfdi, error } = resolverFechaCfdi("2026-07-16", AHORA);
    expect(error).toBeUndefined();
    expect(fechaCfdi?.toISOString()).toBe(new Date("2026-07-16T23:59:00-06:00").toISOString());
  });

  it("hace 2 días → dentro de la ventana de 72 h", () => {
    const { fechaCfdi, error } = resolverFechaCfdi("2026-07-15", AHORA);
    expect(error).toBeUndefined();
    expect(fechaCfdi?.toISOString()).toBe(new Date("2026-07-15T23:59:00-06:00").toISOString());
  });

  it("hace 3 días con fin de día aún dentro de la ventana → válido", () => {
    // now-72h = 14-jul 12:00; el fin de día del 14-jul (23:59) cae dentro.
    const { fechaCfdi, error } = resolverFechaCfdi("2026-07-14", AHORA);
    expect(error).toBeUndefined();
    expect(fechaCfdi?.toISOString()).toBe(new Date("2026-07-14T23:59:00-06:00").toISOString());
  });

  it("fuera de la ventana de 72 h del SAT → error que explica la FechaPago", () => {
    const { fechaCfdi, error } = resolverFechaCfdi("2026-07-13", AHORA);
    expect(fechaCfdi).toBeUndefined();
    expect(error).toMatch(/72 horas/);
    expect(error).toMatch(/FechaPago/);
  });

  it("fecha futura → error", () => {
    expect(resolverFechaCfdi("2026-07-18", AHORA).error).toMatch(/futura/);
  });

  it("formato inválido → error", () => {
    expect(resolverFechaCfdi("17/07/2026", AHORA).error).toMatch(/inválida/);
    expect(resolverFechaCfdi("", AHORA).error).toMatch(/inválida/);
  });
});
