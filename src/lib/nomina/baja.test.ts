import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ find: vi.fn(), update: vi.fn(), imss: vi.fn(), tx: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { employee: { findFirst: m.find, update: m.update }, imssMovimiento: { create: m.imss }, $transaction: m.tx },
}));

import { darDeBaja } from "./baja";

const empleado = {
  id: "e1", nombre: "Ana", apellidoPaterno: "Ruiz", salarioDiario: 500, salarioDiarioIntegrado: 525,
  fechaIngreso: new Date("2022-01-10T00:00:00Z"),
};
const base = { companyId: "c", employeeId: "e1", fechaBaja: "2026-09-15", motivo: "VOLUNTARIA" };

beforeEach(() => {
  vi.clearAllMocks();
  m.find.mockResolvedValue(empleado);
  m.update.mockReturnValue("upd");
  m.imss.mockReturnValue("imss");
  m.tx.mockResolvedValue([]);
});

describe("baja de empleado", () => {
  it("rechaza motivo o fecha inválidos sin tocar nada", async () => {
    expect((await darDeBaja({ ...base, motivo: "DESPIDO" })).status).toBe(400);
    expect((await darDeBaja({ ...base, fechaBaja: "no" })).status).toBe(400);
    expect((await darDeBaja({ ...base, fechaBaja: "2021-01-01" })).status).toBe(400);
    expect(m.tx).not.toHaveBeenCalled();
  });
  it("preview calcula el finiquito y no escribe", async () => {
    const r = await darDeBaja({ ...base, preview: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ preview: true, finiquito: expect.objectContaining({ totalBruto: expect.any(Number) }) });
    expect(m.tx).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });
  it("desactiva y crea la BAJA al IMSS en una sola transacción", async () => {
    const r = await darDeBaja(base);
    expect(r.status).toBe(200);
    expect(m.tx).toHaveBeenCalledWith(["upd", "imss"]);
    expect(m.update.mock.calls[0][0].data).toMatchObject({ isActive: false });
    expect(m.imss.mock.calls[0][0].data).toMatchObject({ tipo: "BAJA", sbcAnterior: 525 });
  });
  it("404 si ya está dado de baja", async () => {
    m.find.mockResolvedValue(null);
    expect((await darDeBaja(base)).status).toBe(404);
  });
});
