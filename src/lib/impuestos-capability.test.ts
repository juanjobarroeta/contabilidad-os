import { beforeEach, describe, expect, it, vi } from "vitest";
import { RegimenCalculationNotSupportedError } from "./fiscal/regimen-capabilities";

const mocks = vi.hoisted(() => ({
  companyFindUnique: vi.fn(),
  invoiceFindMany: vi.fn(),
}));

vi.mock("./prisma", () => ({
  prisma: {
    company: { findUnique: mocks.companyFindUnique },
    invoice: { findMany: mocks.invoiceFindMany },
  },
}));

import { computeTaxPosition } from "./impuestos";

describe("computeTaxPosition regimen gate", () => {
  beforeEach(() => {
    mocks.companyFindUnique.mockReset();
    mocks.invoiceFindMany.mockReset();
  });

  it.each([
    ["603", "AAA010101AAA", "603"],
    ["608", "AAAA010101AAA", "608"],
    ["616", "AAAA010101AAA", "616"],
    ["626", "AAA010101AAA", "626-PM"],
    ["999", "AAA010101AAA", null],
  ])("rejects unsupported %s before reading fiscal data", async (regimenFiscal, rfc, trackId) => {
    mocks.companyFindUnique.mockResolvedValue({
      coeficienteUtilidad: null,
      coeficienteAnio: null,
      perdidaFiscalPendiente: null,
      perdidaFiscalAnio: null,
      regimenFiscal,
      regimenes: [],
      rfc,
      plataformaActividad: null,
    });

    let rejected: unknown;
    try {
      await computeTaxPosition("company-1", 2026, 8);
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toBeInstanceOf(RegimenCalculationNotSupportedError);
    expect((rejected as RegimenCalculationNotSupportedError).toPayload()).toMatchObject({
      code: "NOT_SUPPORTED",
      calculation: "MONTHLY",
      regimen: { trackId },
    });
    expect(mocks.invoiceFindMany).not.toHaveBeenCalled();
  });

  it("rejects multiple CSF regimes before reading or mixing invoices", async () => {
    mocks.companyFindUnique.mockResolvedValue({
      coeficienteUtilidad: null,
      coeficienteAnio: null,
      perdidaFiscalPendiente: null,
      perdidaFiscalAnio: null,
      regimenFiscal: "612",
      regimenes: [
        { code: "606", since: null, endedAt: null, active: true },
        { code: "612", since: null, endedAt: null, active: true },
      ],
      rfc: "AAAA010101AAA",
      plataformaActividad: null,
    });

    await expect(computeTaxPosition("company-1", 2026, 8)).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      status: 422,
      reason: "MULTI_REGIME_COMPOSITION_REQUIRED",
    });
    expect(mocks.invoiceFindMany).not.toHaveBeenCalled();
  });

  it("gates a historical month with its old regime instead of today's scalar", async () => {
    mocks.companyFindUnique.mockResolvedValue({
      coeficienteUtilidad: null,
      coeficienteAnio: null,
      perdidaFiscalPendiente: null,
      perdidaFiscalAnio: null,
      regimenFiscal: "612",
      regimenes: [
        {
          code: "608",
          since: new Date("2024-01-01T00:00:00.000Z"),
          endedAt: new Date("2026-09-15T00:00:00.000Z"),
          active: false,
        },
        {
          code: "612",
          since: new Date("2026-01-01T00:00:00.000Z"),
          endedAt: null,
          active: true,
        },
      ],
      rfc: "AAAA010101AAA",
      plataformaActividad: null,
    });

    await expect(computeTaxPosition("company-1", 2025, 8)).rejects.toMatchObject({
      reason: "ASSISTED_ONLY",
      regimen: { code: "608", trackId: "608" },
    });
    expect(mocks.invoiceFindMany).not.toHaveBeenCalled();
  });
});
