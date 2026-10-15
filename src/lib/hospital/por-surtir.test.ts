import { describe, expect, it, vi } from "vitest";
import { cargarPorSurtir } from "./por-surtir";
import { pasaAlIngreso } from "./episodio";

const partida = (id: string, over: Record<string, unknown> = {}) => ({
  id, cotizacionId: "q1", descripcion: `P ${id}`, categoria: "FARMACIA", cantidad: 2, precioUnitario: 50, ivaTasa: 0, servicioId: null, sinCotizar: false, cargoId: null, ...over,
});

function db(partidas: ReturnType<typeof partida>[], marcadas = 1) {
  const creados: Record<string, unknown>[] = [];
  const tx = {
    hospEpisodio: { findUnique: vi.fn(async () => ({ id: "e1", companyId: "c", folio: "EP-1", estado: "HOSPITALIZADO", tipo: "HOSPITALIZACION", cotizacion: { id: "q1" } })) },
    hospCotizacionPartida: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => partidas.filter((p) => where.id.in.includes(p.id))),
      updateMany: vi.fn(async (_a: { where: Record<string, unknown> }) => ({ count: marcadas })),
    },
    hospCargo: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { creados.push(data); return { id: `cg${creados.length}`, ...data }; }) },
  };
  return { db: { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) } as never, tx, creados };
}
const usuario = { id: "u", nombre: "Farmacia" };

describe("lo cotizado que surte farmacia", () => {
  it("el ingreso no carga medicamento ni material; lo demás sí", () => {
    expect(pasaAlIngreso({ sinCotizar: false, categoria: "FARMACIA" })).toBe(false);
    expect(pasaAlIngreso({ sinCotizar: false, categoria: "MATERIAL" })).toBe(false);
    expect(pasaAlIngreso({ sinCotizar: false, categoria: "QUIROFANO" })).toBe(true);
    expect(pasaAlIngreso({ sinCotizar: true, categoria: "QUIROFANO" })).toBe(false);
  });
  it("carga al precio cotizado, origen FARMACIA, y marca la partida", async () => {
    const { db: d, tx, creados } = db([partida("a"), partida("b", { categoria: "MATERIAL", precioUnitario: 10, cantidad: 3 })]);
    const r = await cargarPorSurtir(d, { companyId: "c", episodioId: "e1", partidaIds: ["a", "b"], usuario });
    expect(r).toMatchObject({ cargos: 2, importe: 130 });
    expect(creados[0]).toMatchObject({ origen: "FARMACIA", precioUnitario: 50, importe: 100, episodioId: "e1" });
    expect(tx.hospCotizacionPartida.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: "a", cargoId: null } });
  });
  it("ya cargada, de otra categoría o ajena: no carga", async () => {
    await expect(cargarPorSurtir(db([partida("a", { cargoId: "x" })]).db, { companyId: "c", episodioId: "e1", partidaIds: ["a"], usuario })).rejects.toMatchObject({ status: 409 });
    await expect(cargarPorSurtir(db([partida("a", { categoria: "QUIROFANO" })]).db, { companyId: "c", episodioId: "e1", partidaIds: ["a"], usuario })).rejects.toMatchObject({ status: 400 });
    await expect(cargarPorSurtir(db([]).db, { companyId: "c", episodioId: "e1", partidaIds: ["zz"], usuario })).rejects.toMatchObject({ status: 400 });
  });
  it("si otra persona se adelantó (carrera), 409 y se revierte", async () => {
    await expect(cargarPorSurtir(db([partida("a")], 0).db, { companyId: "c", episodioId: "e1", partidaIds: ["a"], usuario })).rejects.toMatchObject({ status: 409 });
  });
});
