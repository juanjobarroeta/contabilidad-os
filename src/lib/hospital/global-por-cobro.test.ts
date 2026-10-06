import { describe, expect, it, vi } from "vitest";
import { liberarGlobalPorCobro, marcarGlobalPorCobro } from "./global-por-cobro";

// Un cobro SIN CFDI manda los cargos libres de su episodio a la factura
// global; si se cancela, regresa sólo los que él marcó y siguen libres.

const espia = () => {
  const updateMany = vi.fn(async () => ({ count: 3 }));
  return { db: { hospCargo: { updateMany } } as never, updateMany };
};

describe("marcarGlobalPorCobro()", () => {
  it("marca sólo cargos libres del episodio y deja el id del cobro", async () => {
    const { db, updateMany } = espia();
    expect(await marcarGlobalPorCobro(db, "co1", "ep1", "cob1")).toBe(3);
    const arg = (updateMany.mock.calls[0] as unknown as [{ where: Record<string, unknown>; data: Record<string, unknown> }])[0];
    expect(arg.where).toMatchObject({ episodioId: "ep1", episodio: { companyId: "co1" }, cancelado: false, publicoGeneral: false });
    expect(arg.data).toEqual({ publicoGeneral: true, publicoGeneralCobroId: "cob1" });
  });
});

describe("liberarGlobalPorCobro()", () => {
  it("sólo regresa lo que marcó ese cobro", async () => {
    const { db, updateMany } = espia();
    await liberarGlobalPorCobro(db, "cob1");
    const arg = (updateMany.mock.calls[0] as unknown as [{ where: Record<string, unknown>; data: Record<string, unknown> }])[0];
    expect(arg.where).toMatchObject({ publicoGeneralCobroId: "cob1", publicoGeneral: true });
    expect(arg.data).toEqual({ publicoGeneral: false, publicoGeneralCobroId: null });
  });
});
