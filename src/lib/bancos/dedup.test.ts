import { describe, it, expect } from "vitest";
import { claveDeDuplicado, planImportacion } from "./dedup";

// Regla de conteo: por clave, con F ocurrencias en el archivo y D ya en la
// BD (antes de la subida), se importan max(0, F − D). Las D primeras
// ocurrencias se omiten como posibles duplicados.
describe("planImportacion — regla de conteo max(0, F − D)", () => {
  const k = "clave";

  it("F=2, D=0 → importa las 2 (dos cargos idénticos el mismo día son reales)", () => {
    const plan = planImportacion([k, k], () => 0);
    expect(plan).toEqual([true, true]);
  });

  it("F=2, D=1 → importa 1 (la que faltaba)", () => {
    const plan = planImportacion([k, k], () => 1);
    expect(plan).toEqual([false, true]);
  });

  it("F=1, D=1 → importa 0 (ya estaba)", () => {
    const plan = planImportacion([k], () => 1);
    expect(plan).toEqual([false]);
  });

  it("F=3, D=3 → importa 0 (re-subir el mismo archivo es no-op)", () => {
    const plan = planImportacion([k, k, k], () => 3);
    expect(plan).toEqual([false, false, false]);
  });

  it("re-subida completa de un archivo mixto es no-op (todas las claves con F=D)", () => {
    // Archivo con 3 movimientos: dos idénticos (a) y uno distinto (b).
    // Primera subida sobre BD vacía: entra todo.
    const claves = ["a", "a", "b"];
    const primera = planImportacion(claves, () => 0);
    expect(primera).toEqual([true, true, true]);
    // Segunda subida del MISMO archivo: la BD ya tiene D=F por clave → nada entra.
    const enBD: Record<string, number> = { a: 2, b: 1 };
    const segunda = planImportacion(claves, (c) => enBD[c] ?? 0);
    expect(segunda).toEqual([false, false, false]);
  });

  it("claves distintas no se afectan entre sí", () => {
    const enBD: Record<string, number> = { a: 1, b: 0 };
    expect(planImportacion(["a", "b", "a"], (c) => enBD[c] ?? 0)).toEqual([false, true, true]);
  });

  it("D negativo o basura se trata como 0 (nunca bloquea importación de más)", () => {
    expect(planImportacion([k], () => -2)).toEqual([true]);
  });
});

describe("claveDeDuplicado", () => {
  it("misma clave para dos transacciones idénticas del mismo día", () => {
    const a = { fecha: new Date(Date.UTC(2026, 5, 30, 12)), monto: -450.5, descripcion: "UBER TRIP", referencia: "123" };
    const b = { ...a, fecha: new Date(Date.UTC(2026, 5, 30, 12)) };
    expect(claveDeDuplicado(a)).toBe(claveDeDuplicado(b));
  });

  it("clave distinta si cambia monto, descripción, referencia o día", () => {
    const base = { fecha: new Date(Date.UTC(2026, 5, 30, 12)), monto: -450.5, descripcion: "UBER TRIP", referencia: "123" };
    expect(claveDeDuplicado({ ...base, monto: -450.51 })).not.toBe(claveDeDuplicado(base));
    expect(claveDeDuplicado({ ...base, descripcion: "UBER EATS" })).not.toBe(claveDeDuplicado(base));
    expect(claveDeDuplicado({ ...base, referencia: "124" })).not.toBe(claveDeDuplicado(base));
    expect(claveDeDuplicado({ ...base, fecha: new Date(Date.UTC(2026, 6, 1, 12)) })).not.toBe(claveDeDuplicado(base));
  });

  it("referencia undefined y ausente producen la misma clave", () => {
    const a = { fecha: new Date(Date.UTC(2026, 5, 30, 12)), monto: 100, descripcion: "DEPOSITO", referencia: undefined };
    const b = { fecha: new Date(Date.UTC(2026, 5, 30, 12)), monto: 100, descripcion: "DEPOSITO" };
    expect(claveDeDuplicado(a)).toBe(claveDeDuplicado(b));
  });
});
