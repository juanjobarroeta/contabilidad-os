import { describe, it, expect } from "vitest";
import { claveDeDuplicado, planImportacion, planImportacionConHora } from "./dedup";

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

// La hora del formato pegado identifica al movimiento dentro del día: dos
// SPEI idénticos el mismo día (13:07 y 15:07) pegados en momentos DISTINTOS
// deben entrar ambos — la regla F − D por día sola omitía el segundo.
describe("planImportacionConHora — pegados parciales con hora", () => {
  const k = "dia|-10000|sweb transf. interb spei|";
  const sinLegado = () => 0;

  it("pegados parciales: cada 10k llega en un pegado distinto y ambos entran", () => {
    // Pegado 1: sólo el de las 13:07, BD vacía.
    expect(planImportacionConHora([{ clave: k, hora: "13:07:00" }], sinLegado, () => 0)).toEqual([
      true,
    ]);
    // Pegado 2: sólo el de las 15:07; la BD ya tiene el de las 13:07.
    const enBDHora = (_: string, h: string) => (h === "13:07:00" ? 1 : 0);
    expect(planImportacionConHora([{ clave: k, hora: "15:07:00" }], sinLegado, enBDHora)).toEqual([
      true,
    ]);
  });

  it("re-pegar un movimiento ya guardado con su hora es no-op", () => {
    const enBDHora = (_: string, h: string) => (h === "13:07:00" ? 1 : 0);
    expect(planImportacionConHora([{ clave: k, hora: "13:07:00" }], sinLegado, enBDHora)).toEqual([
      false,
    ]);
  });

  it("dos movimientos con la MISMA hora exacta en un pegado: F − D por (clave, hora)", () => {
    expect(
      planImportacionConHora(
        [
          { clave: k, hora: "13:07:00" },
          { clave: k, hora: "13:07:00" },
        ],
        sinLegado,
        () => 0,
      ),
    ).toEqual([true, true]);
    expect(
      planImportacionConHora(
        [
          { clave: k, hora: "13:07:00" },
          { clave: k, hora: "13:07:00" },
        ],
        sinLegado,
        () => 1,
      ),
    ).toEqual([false, true]);
  });

  it("renglones legado (sin hora en BD) cubren re-pegados sin re-importar", () => {
    // BD: un renglón viejo del día sin hora (referencia NULL). Re-pegado
    // completo del día con ambos 10k: el legado cubre uno, el otro entra.
    const legado = () => 1;
    expect(
      planImportacionConHora(
        [
          { clave: k, hora: "15:07:00" },
          { clave: k, hora: "13:07:00" },
        ],
        legado,
        () => 0,
      ),
    ).toEqual([false, true]);
  });

  it("estable tras la recuperación: re-pegar de nuevo ya no importa nada", () => {
    // BD tras el caso anterior: 1 legado + 1 con hora 13:07.
    const legado = () => 1;
    const enBDHora = (_: string, h: string) => (h === "13:07:00" ? 1 : 0);
    expect(
      planImportacionConHora(
        [
          { clave: k, hora: "15:07:00" },
          { clave: k, hora: "13:07:00" },
        ],
        legado,
        enBDHora,
      ),
    ).toEqual([false, false]);
  });

  it("filas sin hora siguen la regla clásica F − D", () => {
    expect(
      planImportacionConHora(
        [
          { clave: k, hora: null },
          { clave: k, hora: null },
        ],
        () => 1,
        () => 0,
      ),
    ).toEqual([false, true]);
  });
});
