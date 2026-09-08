import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  movimientos: 0,
  count: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bankTransaction: {
      count: state.count,
    },
    conciliacionBancaria: {
      upsert: state.upsert,
    },
  },
}));

const {
  ConciliacionSinDatosError,
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
