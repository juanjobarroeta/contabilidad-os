import { describe, expect, it } from "vitest";
import {
  invoiceRegimenPeriodContext,
  validateInvoiceRegimenAllocations,
} from "./regimen-allocation";

describe("invoiceRegimenPeriodContext", () => {
  it("uses only the regimes overlapping the invoice fiscal month", () => {
    const context = invoiceRegimenPeriodContext({
      fecha: new Date("2025-06-15T12:00:00.000Z"),
      regimenFiscal: "626",
      regimenes: [
        {
          code: "612",
          since: new Date("2024-01-01T00:00:00.000Z"),
          endedAt: new Date("2026-01-01T00:00:00.000Z"),
          active: false,
        },
        {
          code: "626",
          since: new Date("2026-01-01T00:00:00.000Z"),
          endedAt: null,
          active: true,
        },
      ],
    });

    expect(context).toMatchObject({
      periodo: "2025-06",
      regimenCodes: ["612"],
    });
    expect(context?.from.toISOString()).toBe("2025-06-01T00:00:00.000Z");
    expect(context?.to.toISOString()).toBe("2025-07-01T00:00:00.000Z");
  });

  it("does not fall back to today's scalar when lifecycle evidence has no overlap", () => {
    const context = invoiceRegimenPeriodContext({
      fecha: new Date("2025-06-15T00:00:00.000Z"),
      regimenFiscal: "612",
      regimenes: [
        {
          code: "626",
          since: new Date("2026-01-01T00:00:00.000Z"),
          endedAt: null,
          active: true,
        },
      ],
    });

    expect(context?.regimenCodes).toEqual([]);
  });

  it("rejects an invalid invoice date", () => {
    expect(invoiceRegimenPeriodContext({
      fecha: new Date("invalid"),
      regimenFiscal: "612",
      regimenes: [],
    })).toBeNull();
  });
});

describe("validateInvoiceRegimenAllocations", () => {
  it("accepts one complete 100% attribution", () => {
    expect(validateInvoiceRegimenAllocations({
      effectiveRegimenCodes: ["612", "606"],
      allocations: [{ regimenCode: "612", basisPoints: 10_000 }],
    })).toEqual({
      ok: true,
      allocations: [{ regimenCode: "612", basisPoints: 10_000 }],
      totalBasisPoints: 10_000,
    });
  });

  it("accepts an exact split and normalizes regime whitespace", () => {
    expect(validateInvoiceRegimenAllocations({
      effectiveRegimenCodes: ["612", "606"],
      allocations: [
        { regimenCode: " 612 ", basisPoints: 6_250 },
        { regimenCode: "606", basisPoints: 3_750 },
      ],
    })).toMatchObject({
      ok: true,
      allocations: [
        { regimenCode: "612", basisPoints: 6_250 },
        { regimenCode: "606", basisPoints: 3_750 },
      ],
    });
  });

  it.each([
    {
      name: "has no effective regime evidence",
      effectiveRegimenCodes: [],
      allocations: [{ regimenCode: "612", basisPoints: 10_000 }],
      code: "NO_EFFECTIVE_REGIMES",
    },
    {
      name: "is empty",
      effectiveRegimenCodes: ["612"],
      allocations: [],
      code: "ALLOCATIONS_REQUIRED",
    },
    {
      name: "contains an unknown regime",
      effectiveRegimenCodes: ["999"],
      allocations: [{ regimenCode: "999", basisPoints: 10_000 }],
      code: "UNKNOWN_REGIME",
    },
    {
      name: "contains a regime outside the invoice period",
      effectiveRegimenCodes: ["612"],
      allocations: [{ regimenCode: "626", basisPoints: 10_000 }],
      code: "REGIME_OUTSIDE_PERIOD",
    },
    {
      name: "repeats a regime",
      effectiveRegimenCodes: ["612"],
      allocations: [
        { regimenCode: "612", basisPoints: 5_000 },
        { regimenCode: "612", basisPoints: 5_000 },
      ],
      code: "DUPLICATE_REGIME",
    },
    {
      name: "uses fractional basis points",
      effectiveRegimenCodes: ["612"],
      allocations: [{ regimenCode: "612", basisPoints: 9_999.5 }],
      code: "INVALID_BASIS_POINTS",
    },
    {
      name: "does not sum to 100 percent",
      effectiveRegimenCodes: ["612", "606"],
      allocations: [
        { regimenCode: "612", basisPoints: 6_000 },
        { regimenCode: "606", basisPoints: 3_999 },
      ],
      code: "INCOMPLETE_ALLOCATION",
    },
  ])("fails closed when the allocation $name", ({ effectiveRegimenCodes, allocations, code }) => {
    expect(validateInvoiceRegimenAllocations({
      effectiveRegimenCodes,
      allocations,
    })).toMatchObject({ ok: false, code });
  });
});
