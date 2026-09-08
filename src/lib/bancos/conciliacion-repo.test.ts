import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  movimientos: 0,
  count: vi.fn(),
  upsert: vi.fn(),
  closeUpsert: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bankTransaction: {
      count: state.count,
    },
    conciliacionBancaria: {
      upsert: state.upsert,
    },
    cierrePeriodo: {
      upsert: state.closeUpsert,
    },
  },
}));

const {
  ConciliacionSinDatosError,
  ConfirmacionSinActividadConDatosError,
  ConfirmacionSinActividadNotaError,
  confirmarSinActividadBancaria,
  firmarConciliacion,
} = await import("./conciliacion-repo");

const args = {
  companyId: "company-1",
  bankAccountId: "bank-1",
  year: 2026,
  month: 8,
  userId: "user-1",
  conciliado: true,
};

describe("firmarConciliacion", () => {
  beforeEach(() => {
    state.movimientos = 0;
    state.count.mockReset().mockImplementation(async () => state.movimientos);
    state.upsert.mockReset().mockResolvedValue({ id: "signature-1" });
    state.closeUpsert.mockReset().mockResolvedValue({ id: "close-1" });
  });

  it("refuses to create a reconciliation signature without bank evidence", async () => {
    await expect(firmarConciliacion(args)).rejects.toBeInstanceOf(ConciliacionSinDatosError);
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it("allows a signature only when the account has movements in that period", async () => {
    state.movimientos = 2;
    await expect(firmarConciliacion(args)).resolves.toEqual({ id: "signature-1" });
    expect(state.upsert).toHaveBeenCalledOnce();
  });

  it("always permits removal of a legacy empty signature", async () => {
    await expect(
      firmarConciliacion({ ...args, conciliado: false }),
    ).resolves.toEqual({ id: "signature-1" });
    expect(state.count).not.toHaveBeenCalled();
  });
});

describe("confirmarSinActividadBancaria", () => {
  beforeEach(() => {
    state.movimientos = 0;
    state.count.mockReset().mockImplementation(async () => state.movimientos);
    state.closeUpsert.mockReset().mockResolvedValue({ id: "close-1" });
  });

  it("persists an attributed confirmation only when the period is empty", async () => {
    await expect(
      confirmarSinActividadBancaria({
        companyId: "company-1",
        year: 2026,
        month: 8,
        userId: "user-1",
        confirmada: true,
        nota: "La empresa no utilizó cuentas bancarias este mes.",
      }),
    ).resolves.toEqual({ id: "close-1" });
    expect(state.closeUpsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        sinActividadBancariaByUserId: "user-1",
        sinActividadBancariaNota: "La empresa no utilizó cuentas bancarias este mes.",
      }),
    }));
  });

  it("enforces the explanation invariant below the API boundary", async () => {
    await expect(
      confirmarSinActividadBancaria({
        companyId: "company-1",
        year: 2026,
        month: 8,
        userId: "user-1",
        confirmada: true,
        nota: "Muy breve",
      }),
    ).rejects.toBeInstanceOf(ConfirmacionSinActividadNotaError);
    expect(state.count).not.toHaveBeenCalled();
    expect(state.closeUpsert).not.toHaveBeenCalled();
  });

  it("refuses the declaration as soon as bank data exists", async () => {
    state.movimientos = 1;
    await expect(
      confirmarSinActividadBancaria({
        companyId: "company-1",
        year: 2026,
        month: 8,
        userId: "user-1",
        confirmada: true,
        nota: "Sin actividad bancaria durante este mes.",
      }),
    ).rejects.toBeInstanceOf(ConfirmacionSinActividadConDatosError);
    expect(state.closeUpsert).not.toHaveBeenCalled();
  });

  it("allows revocation without requiring the period to remain empty", async () => {
    state.movimientos = 4;
    await confirmarSinActividadBancaria({
      companyId: "company-1",
      year: 2026,
      month: 8,
      userId: "user-1",
      confirmada: false,
    });
    expect(state.count).not.toHaveBeenCalled();
    expect(state.closeUpsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ sinActividadBancariaAt: null }),
    }));
  });
});
