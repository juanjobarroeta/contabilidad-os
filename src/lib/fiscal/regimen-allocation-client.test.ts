import { describe, expect, it } from "vitest";
import {
  buildRegimenAllocationDraft,
  percentageInputFromBasisPoints,
  percentageInputToBasisPoints,
  regimenPercentageDraft,
  type InvoiceRegimenOption,
} from "./regimen-allocation-client";

const regimenes: InvoiceRegimenOption[] = [
  { code: "606", label: "Arrendamiento" },
  { code: "612", label: "Actividades empresariales y profesionales" },
];

describe("percentageInputToBasisPoints", () => {
  it.each([
    ["", 0],
    ["0", 0],
    ["40", 4_000],
    ["40.5", 4_050],
    ["40,25", 4_025],
    ["100.00", 10_000],
  ])("parses %s exactly", (input, expected) => {
    expect(percentageInputToBasisPoints(input)).toBe(expected);
  });

  it.each(["-1", "100.01", "1.234", "abc", "1,2.3"])("rejects %s", (input) => {
    expect(percentageInputToBasisPoints(input)).toBeNull();
  });
});

describe("allocation editor draft", () => {
  it("hydrates only allocations that are still available", () => {
    expect(regimenPercentageDraft(regimenes, {
      revision: 2,
      reviewedById: "user-1",
      reviewedByEmail: "contador@example.com",
      reviewedAt: "2026-09-15T12:00:00.000Z",
      note: null,
      allocations: [
        { regimenCode: "606", basisPoints: 3_333, porcentaje: 33.33 },
        { regimenCode: "626", basisPoints: 6_667, porcentaje: 66.67 },
      ],
    })).toEqual({ "606": "33.33", "612": "" });
  });

  it("formats exact basis points without trailing zero noise", () => {
    expect(percentageInputFromBasisPoints(10_000)).toBe("100");
    expect(percentageInputFromBasisPoints(4_050)).toBe("40.5");
    expect(percentageInputFromBasisPoints(3_333)).toBe("33.33");
  });

  it("builds a complete replacement and omits zero shares", () => {
    expect(buildRegimenAllocationDraft(regimenes, {
      "606": "0",
      "612": "100",
    })).toEqual({
      ok: true,
      totalBasisPoints: 10_000,
      allocations: [{ regimenCode: "612", basisPoints: 10_000 }],
    });
  });

  it("blocks incomplete and malformed drafts", () => {
    expect(buildRegimenAllocationDraft(regimenes, {
      "606": "60",
      "612": "39.99",
    })).toMatchObject({ ok: false, totalBasisPoints: 9_999 });

    expect(buildRegimenAllocationDraft(regimenes, {
      "606": "60.001",
      "612": "40",
    })).toMatchObject({ ok: false, totalBasisPoints: null });
  });
});
