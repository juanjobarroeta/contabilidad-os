import { describe, expect, it, vi } from "vitest";
import { consultarPorLotes, enLotes, TAM_LOTE } from "./prisma-lotes";

describe("enLotes", () => {
  it("parte la lista en lotes del tamaño pedido", () => {
    expect(enLotes([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("una lista más corta que el lote queda en uno solo", () => {
    expect(enLotes([1, 2], 10)).toEqual([[1, 2]]);
  });

  it("lista vacía no produce lotes", () => {
    expect(enLotes([], 10)).toEqual([]);
  });

  it("un tamaño inválido no cuelga el proceso", () => {
    // Con paso 0 el bucle nunca avanzaría: se fuerza a 1 como mínimo.
    expect(enLotes([1, 2, 3], 0)).toEqual([[1], [2], [3]]);
    expect(enLotes([1, 2, 3], -5)).toEqual([[1], [2], [3]]);
  });

  it("el lote por defecto va muy por debajo del tope de Postgres (32,767)", () => {
    // Una fila puede aportar más de un parámetro y el resto del `where` gasta.
    expect(TAM_LOTE).toBeLessThan(32_767 / 2);
  });

  it("no pierde ni duplica elementos", () => {
    const items = Array.from({ length: 12_345 }, (_, i) => i);
    const lotes = enLotes(items, TAM_LOTE);
    expect(lotes.flat()).toEqual(items);
    expect(lotes.every((l) => l.length <= TAM_LOTE)).toBe(true);
  });
});

describe("consultarPorLotes", () => {
  it("concatena el resultado de cada lote en orden", async () => {
    const r = await consultarPorLotes([1, 2, 3, 4, 5], async (lote) => lote.map((n) => n * 10), 2);
    expect(r).toEqual([10, 20, 30, 40, 50]);
  });

  it("sin elementos no llama a la consulta (ni una vacía)", async () => {
    const consulta = vi.fn(async () => []);
    expect(await consultarPorLotes([], consulta)).toEqual([]);
    expect(consulta).not.toHaveBeenCalled();
  });

  it("llama una vez por lote", async () => {
    const consulta = vi.fn(async (lote: number[]) => lote);
    await consultarPorLotes([1, 2, 3, 4, 5], consulta, 2);
    expect(consulta).toHaveBeenCalledTimes(3);
  });

  it("los lotes van en SERIE, no en paralelo", async () => {
    // En paralelo, una lista de 200 mil abriría decenas de consultas pesadas a
    // la vez contra la misma base.
    let enVuelo = 0;
    let maxEnVuelo = 0;
    await consultarPorLotes(
      [1, 2, 3, 4, 5, 6],
      async (lote) => {
        enVuelo++;
        maxEnVuelo = Math.max(maxEnVuelo, enVuelo);
        await new Promise((r) => setTimeout(r, 1));
        enVuelo--;
        return lote;
      },
      2
    );
    expect(maxEnVuelo).toBe(1);
  });

  it("un lote grande se parte de verdad (el caso que reventaba en producción)", async () => {
    // ~60 mil uuids (los REP de la empresa más grande, con sus variantes de
    // mayúsculas) pasaban el tope de 32,767 parámetros de Postgres.
    const uuids = Array.from({ length: 60_000 }, (_, i) => `uuid-${i}`);
    const tamanos: number[] = [];
    await consultarPorLotes(uuids, async (lote) => {
      tamanos.push(lote.length);
      return [];
    });
    expect(tamanos.length).toBeGreaterThan(1);
    expect(Math.max(...tamanos)).toBeLessThan(32_767);
  });
});
