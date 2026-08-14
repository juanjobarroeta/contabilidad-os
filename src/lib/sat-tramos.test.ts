import { describe, it, expect } from "vitest";
import { partirMes, isoLocal, etiquetaTramo, MAX_TRAMOS } from "./sat-tramos";

// Lo que se está protegiendo: si los tramos dejan un hueco, esos CFDIs no se
// piden y el mes queda incompleto OTRA VEZ — el defecto que estamos arreglando.
// Si se traslapan, un CFDI se pide dos veces y gastamos cuota de más.

describe("partirMes", () => {
  it("sin tramos es el mes completo", () => {
    const t = partirMes(2025, 4);
    expect(t).toHaveLength(1);
    expect(isoLocal(t[0].desde)).toBe("2025-04-01T00:00:00");
    expect(isoLocal(t[0].hasta)).toBe("2025-04-30T23:59:59");
  });

  it("parte abril en dos mitades exactas", () => {
    const t = partirMes(2025, 4, 2);
    expect(t.map((x) => [isoLocal(x.desde), isoLocal(x.hasta)])).toEqual([
      ["2025-04-01T00:00:00", "2025-04-15T23:59:59"],
      ["2025-04-16T00:00:00", "2025-04-30T23:59:59"],
    ]);
  });

  it("reparte los días sobrantes en los primeros tramos, no al final", () => {
    // 31 días en 2: 16 + 15. Nunca 15 + 15 y un día que nadie pide.
    const t = partirMes(2025, 1, 2);
    expect(isoLocal(t[0].hasta)).toBe("2025-01-16T23:59:59");
    expect(isoLocal(t[1].desde)).toBe("2025-01-17T00:00:00");
    expect(isoLocal(t[1].hasta)).toBe("2025-01-31T23:59:59");
  });

  it("cubre el mes entero sin huecos ni traslapes, para cualquier partición", () => {
    for (const [year, month] of [[2025, 4], [2025, 1], [2024, 2], [2023, 2], [2022, 6]] as const) {
      const dias = new Date(year, month, 0).getDate();
      for (let n = 1; n <= dias; n++) {
        const t = partirMes(year, month, n);
        // Empieza el día 1 y acaba el último día del mes.
        expect(t[0].desde.getDate()).toBe(1);
        expect(t[t.length - 1].hasta.getDate()).toBe(dias);
        // Contiguos: cada tramo arranca justo el día siguiente al anterior.
        for (let i = 1; i < t.length; i++) {
          const finAnterior = t[i - 1].hasta;
          const inicio = t[i].desde;
          expect(inicio.getTime() - finAnterior.getTime()).toBe(1000); // 23:59:59 → 00:00:00
        }
        // Y ningún tramo va al revés.
        for (const x of t) expect(x.hasta.getTime()).toBeGreaterThan(x.desde.getTime());
      }
    }
  });

  it("febrero bisiesto llega al 29", () => {
    const t = partirMes(2024, 2, 1);
    expect(isoLocal(t[0].hasta)).toBe("2024-02-29T23:59:59");
  });

  it("no devuelve tramos vacíos si piden más tramos que días", () => {
    const t = partirMes(2025, 2, 99);
    expect(t).toHaveLength(28); // uno por día, ni uno más
    expect(isoLocal(t[0].hasta)).toBe("2025-02-01T23:59:59");
    expect(isoLocal(t[27].desde)).toBe("2025-02-28T00:00:00");
  });

  it("aguanta basura en el número de tramos sin inventar rangos", () => {
    for (const malo of [0, -5, 0.5, NaN]) {
      const t = partirMes(2025, 4, malo);
      expect(t).toHaveLength(1);
      expect(isoLocal(t[0].desde)).toBe("2025-04-01T00:00:00");
      expect(isoLocal(t[0].hasta)).toBe("2025-04-30T23:59:59");
    }
  });

  it("nunca pasa de MAX_TRAMOS", () => {
    expect(partirMes(2025, 1, 60).length).toBeLessThanOrEqual(MAX_TRAMOS);
  });
});

describe("etiquetaTramo", () => {
  it("dice el rango en corto", () => {
    expect(etiquetaTramo(partirMes(2025, 4, 2)[0])).toBe("04-01→04-15");
  });
});
