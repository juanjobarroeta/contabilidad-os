import { describe, expect, it, vi } from "vitest";

vi.mock("./asientos", () => ({ asentarMovimientoKardex: vi.fn(async () => undefined) }));

import { cancelarCargo, reducirCargo } from "./cargos";

function tx(over: Record<string, unknown> = {}) {
  const cargo = {
    id: "cg1", companyId: "c", episodioId: "e1", cantidad: 10, precioUnitario: 50, ivaContexto: "SUMINISTRO_HOSPITALARIO", ivaTasa: 0,
    invoiceId: null, invoice: null, prefacturaId: null, cancelado: false, cotizacionPartidaId: "p1",
    movimientoInsumo: { id: "m1", insumoId: "i1", loteId: "l1", cantidad: -10, costoUnitario: 20, asientoAt: null },
    ...over,
  };
  const movs: Record<string, unknown>[] = [];
  const t = {
    hospCargo: { findUnique: vi.fn(async () => cargo), update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...cargo, ...data })) },
    hospMovimientoInsumo: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { movs.push(data); return { id: `d${movs.length}`, ...data }; }) },
    hospLote: { update: vi.fn(async () => ({})) },
    hospCotizacionPartida: { update: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 0 })) },
    facturaBorrador: { findUnique: vi.fn(async () => null) },
  };
  return { t: t as never, raw: t, movs };
}
const usuario = { id: "u", nombre: "Farmacia" };

describe("devolución parcial de farmacia", () => {
  it("baja el cargo y regresa sólo la diferencia al mismo lote; reabre la partida", async () => {
    const { t, raw, movs } = tx();
    const r = await reducirCargo(t, "cg1", { cantidad: 7, motivo: "sobró", usuario });
    expect(raw.hospCargo.update.mock.calls[0][0]).toMatchObject({ data: { cantidad: 7, importe: 350 } });
    expect(movs[0]).toMatchObject({ tipo: "DEVOLUCION", cantidad: 3, loteId: "l1" });
    expect(movs[0].referencia).toMatch(/^Devolución parcial del cargo cg1:/);
    expect(raw.hospLote.update).toHaveBeenCalledWith({ where: { id: "l1" }, data: { existencia: { increment: 3 } } });
    expect(raw.hospCotizacionPartida.update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { surtidaAt: null, surtidaPor: null } });
    expect(r.devolucion).toEqual({ id: "d1", cantidad: 3 });
  });
  it("no se devuelve de más, ni a cero, ni lo que no salió con lote, ni lo facturado", async () => {
    await expect(reducirCargo(tx().t, "cg1", { cantidad: 10, motivo: "x" })).rejects.toMatchObject({ status: 400 });
    await expect(reducirCargo(tx().t, "cg1", { cantidad: 0, motivo: "x" })).rejects.toMatchObject({ status: 400 });
    await expect(reducirCargo(tx({ movimientoInsumo: null }).t, "cg1", { cantidad: 5, motivo: "x" })).rejects.toMatchObject({ status: 400 });
    await expect(reducirCargo(tx({ invoiceId: "inv", invoice: { status: "VALID" } }).t, "cg1", { cantidad: 5, motivo: "x" })).rejects.toMatchObject({ status: 409 });
  });
  it("cancelar un cargo ya reducido regresa sólo lo que sigue cargado", async () => {
    const { t, movs } = tx({ cantidad: 7 });
    await cancelarCargo(t, "cg1", { motivo: "no se usó", usuario });
    expect(movs[0]).toMatchObject({ tipo: "DEVOLUCION", cantidad: 7 });
  });
  it("cancelar libera la partida cargada sin inventario", async () => {
    const { t, raw } = tx({ movimientoInsumo: null, cotizacionPartidaId: null });
    await cancelarCargo(t, "cg1", { motivo: "error" });
    expect(raw.hospCotizacionPartida.updateMany).toHaveBeenCalledWith({ where: { cargoId: "cg1" }, data: { cargoId: null, surtidaAt: null, surtidaPor: null } });
  });
});
