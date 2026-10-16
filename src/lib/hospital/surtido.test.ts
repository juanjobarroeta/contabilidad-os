import { describe, expect, it, vi } from "vitest";

vi.mock("./aplicar-insumo", () => ({
  aplicarEnTx: vi.fn(async (_tx: unknown, a: { loteId: string; cantidad: number }, o: { precioUnitario?: number; cotizacionPartidaId?: string | null; sufijo?: string }) => ({
    cargo: { id: `cg-${a.loteId}-${o.cotizacionPartidaId ? "cot" : "extra"}`, importe: a.cantidad * (o.precioUnitario ?? 80), ...o, cantidad: a.cantidad, loteId: a.loteId },
    advertencias: [],
  })),
}));

import { aplicarEnTx } from "./aplicar-insumo";
import { palabrasClave, pendienteDe, planFefo, puntaje, repartirCotizado, surtirPartida } from "./surtido";

const hoy = new Date("2026-10-16T00:00:00.000Z");
const lote = (id: string, existencia: number, caducidad: string | null, over: Record<string, unknown> = {}) => ({
  id, lote: `L${id}`, almacen: "GENERAL", caducidad: caducidad ? new Date(caducidad) : null, existencia, bloqueado: false, recibidoAt: new Date("2026-01-01"), ...over,
});

describe("plan FEFO", () => {
  it("toma el que caduca primero y se parte entre lotes", () => {
    const p = planFefo([lote("b", 5, "2027-06-01"), lote("a", 3, "2026-12-01", { almacen: "CEYE" })], 6, hoy);
    expect(p.tramos.map((t) => [t.loteId, t.almacen, t.cantidad])).toEqual([["a", "CEYE", 3], ["b", "GENERAL", 3]]);
    expect(p).toMatchObject({ disponible: 8, faltante: 0 });
  });
  it("ignora caducados, bloqueados, sin caducidad y vacíos", () => {
    const p = planFefo([lote("v", 9, "2026-01-01"), lote("x", 9, "2027-01-01", { bloqueado: true }), lote("s", 9, null), lote("z", 0, "2027-01-01"), lote("ok", 2, "2027-01-01")], 5, hoy);
    expect(p).toMatchObject({ disponible: 2, faltante: 3 });
  });
});

describe("lo cotizado y lo de más", () => {
  it("a precio cotizado hasta lo pendiente; el resto fuera de cotización", () => {
    const tramos = [{ loteId: "a", lote: "La", almacen: "G", caducidad: null, cantidad: 3 }, { loteId: "b", lote: "Lb", almacen: "G", caducidad: null, cantidad: 4 }];
    expect(repartirCotizado(tramos, 5).map((t) => [t.loteId, t.cantidad, t.cotizada])).toEqual([["a", 3, true], ["b", 2, true], ["b", 2, false]]);
    expect(repartirCotizado(tramos, 0).every((t) => !t.cotizada)).toBe(true);
  });
  it("pendiente: cantidad menos entregas vivas; cargada sin inventario no tiene pendiente", () => {
    expect(pendienteDe({ cantidad: 10 }, [{ cantidad: 4 }, { cantidad: 2 }])).toEqual({ surtido: 6, pendiente: 4 });
    expect(pendienteDe({ cantidad: 10 }, [{ cantidad: 12 }])).toEqual({ surtido: 12, pendiente: 0 });
    expect(pendienteDe({ cantidad: 10, cargoId: "c" }, [])).toEqual({ surtido: 10, pendiente: 0 });
  });
});

describe("sugerencia de insumo", () => {
  it("clave igual manda; luego palabras y dosis", () => {
    const partida = { clave: "MED123", descripcion: "Paracetamol 500 mg tabletas" };
    expect(puntaje({ clave: "med123", nombre: "Otro" }, partida)).toBeGreaterThanOrEqual(100);
    expect(puntaje({ clave: "X1", nombre: "PARACETAMOL 500MG C/10" }, partida)).toBeGreaterThan(puntaje({ clave: "X2", nombre: "Paracetamol 750 mg" }, partida));
    expect(palabrasClave("Sutura de seda 2-0 con aguja")).toEqual(["sutura", "seda", "aguja"]);
  });
});

function db(over: { partida?: Record<string, unknown>; lotes?: ReturnType<typeof lote>[]; insumo?: Record<string, unknown> } = {}) {
  const partida = {
    id: "p1", descripcion: "Paracetamol 500 mg", categoria: "FARMACIA", cantidad: 5, precioUnitario: 50, sinCotizar: false, cargoId: null, servicioId: "s1", cotizacionId: "q1",
    cotizacion: { companyId: "c", folio: "COT-9" }, servicio: { id: "s1", clave: "MED1", insumoId: null }, surtidos: [{ cantidad: 2 }], ...over.partida,
  };
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    hospCotizacionPartida: { findUnique: vi.fn(async () => partida), update: vi.fn(async () => ({})) },
    hospEpisodio: { findUnique: vi.fn(async () => ({ id: "e1", companyId: "c", folio: "EP-1", medicoId: "m1", cotizacion: { id: "q1" } })) },
    hospInsumo: { findFirst: vi.fn(async () => ({ id: "i1", nombre: "Paracetamol", unidad: "tab", activo: true, grupoControl: null, lotes: over.lotes ?? [lote("a", 2, "2026-12-01"), lote("b", 10, "2027-05-01")], ...over.insumo })) },
    hospServicio: { update: vi.fn(async () => ({})) },
  };
  return { db: { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) } as never, tx };
}
const base = { companyId: "c", episodioId: "e1", partidaId: "p1", insumoId: "i1", usuario: { id: "u", nombre: "Farmacia" } };

describe("surtir una partida contra inventario", () => {
  it("parte entre lotes, cobra lo pendiente a precio cotizado y lo de más a lista; liga el servicio", async () => {
    vi.mocked(aplicarEnTx).mockClear();
    const { db: d, tx } = db();
    const r = await surtirPartida(d, { ...base, cantidad: 4 });
    // pendiente 3 (5 − 2 entregados): lote a 2 + lote b 1 cotizados, lote b 1 extra.
    const llamadas = vi.mocked(aplicarEnTx).mock.calls.map(([, a, o]) => [a.loteId, a.cantidad, o.precioUnitario ?? null, o.cotizacionPartidaId ?? null]);
    expect(llamadas).toEqual([["a", 2, 50, "p1"], ["b", 1, 50, "p1"], ["b", 1, null, null]]);
    expect(r).toMatchObject({ cotizado: 3, extra: 1, pendiente: 0 });
    expect(tx.hospServicio.update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { insumoId: "i1" } });
    expect(tx.hospCotizacionPartida.update).toHaveBeenCalled();
    // No es controlado: el cargo no lleva médico.
    expect(vi.mocked(aplicarEnTx).mock.calls[0][1].medicoId).toBeNull();
  });
  it("parcial: no marca surtida y no cambia el insumo ya ligado sin «recordar»", async () => {
    const { db: d, tx } = db({ partida: { surtidos: [], servicio: { id: "s1", clave: "MED1", insumoId: "otro" } } });
    const r = await surtirPartida(d, { ...base, cantidad: 2 });
    expect(r.pendiente).toBe(3);
    expect(tx.hospCotizacionPartida.update).not.toHaveBeenCalled();
    expect(tx.hospServicio.update).not.toHaveBeenCalled();
  });
  it("sin existencia suficiente: 409 y no toca nada", async () => {
    vi.mocked(aplicarEnTx).mockClear();
    const { db: d } = db({ lotes: [lote("a", 1, "2027-01-01")] });
    await expect(surtirPartida(d, { ...base, cantidad: 3 })).rejects.toMatchObject({ status: 409 });
    expect(aplicarEnTx).not.toHaveBeenCalled();
  });
  it("controlado: el prescriptor es el médico del episodio", async () => {
    vi.mocked(aplicarEnTx).mockClear();
    const { db: d } = db({ insumo: { grupoControl: "II" } });
    await surtirPartida(d, { ...base, cantidad: 1, recetaRef: "RX-100" });
    expect(vi.mocked(aplicarEnTx).mock.calls[0][1]).toMatchObject({ medicoId: "m1", recetaRef: "RX-100" });
  });
  it("partida de otra cotización o cargada sin inventario: no", async () => {
    await expect(surtirPartida(db({ partida: { cotizacionId: "otra" } }).db, { ...base, cantidad: 1 })).rejects.toMatchObject({ status: 400 });
    await expect(surtirPartida(db({ partida: { cargoId: "cg" } }).db, { ...base, cantidad: 1 })).rejects.toMatchObject({ status: 409 });
  });
});
