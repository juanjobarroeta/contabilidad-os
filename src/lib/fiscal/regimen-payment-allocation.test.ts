import { describe, expect, it } from "vitest";
import {
  allocateCentavosByBasisPoints,
  projectPpdRegimenAllocation,
  proratePpdBaseCentavos,
  validatePpdPaymentHistory,
} from "./regimen-payment-allocation";

describe("validatePpdPaymentHistory", () => {
  it("accepts a complete stamped REP history up to the exact parent total", () => {
    expect(validatePpdPaymentHistory({
      parentTotalMicropesos: 1_160_000_000,
      paymentAmountsMicropesos: [580_000_000, 580_000_000],
    })).toEqual({ ok: true, totalPaidMicropesos: 1_160_000_000 });
  });

  it.each([
    { paymentAmountsMicropesos: [] },
    { paymentAmountsMicropesos: [580_000_000, null] },
    { paymentAmountsMicropesos: [580_000_000, 0] },
    { paymentAmountsMicropesos: [580_000_000, 1.5] },
  ])("fails closed when the payment history is incomplete or invalid", ({ paymentAmountsMicropesos }) => {
    expect(validatePpdPaymentHistory({
      parentTotalMicropesos: 1_160_000_000,
      paymentAmountsMicropesos,
    })).toMatchObject({ ok: false, code: "PAYMENT_HISTORY_AMOUNT_UNAVAILABLE" });
  });

  it("blocks cumulative stamped payments above the parent total", () => {
    expect(validatePpdPaymentHistory({
      parentTotalMicropesos: 1_160_000_000,
      paymentAmountsMicropesos: [700_000_000, 580_000_000],
    })).toMatchObject({ ok: false, code: "CUMULATIVE_PAYMENT_EXCEEDS_PARENT_TOTAL" });
  });
});

describe("proratePpdBaseCentavos", () => {
  it("derives the subtotal-equivalent base using integer arithmetic", () => {
    expect(proratePpdBaseCentavos({
      impPagadoMicropesos: 580_000_000,
      parentSubtotalMicropesos: 1_000_000_000,
      parentTotalMicropesos: 1_160_000_000,
    })).toEqual({ ok: true, amount: 50_000 });
  });

  it("rounds an exact half cent up", () => {
    expect(proratePpdBaseCentavos({
      impPagadoMicropesos: 1,
      parentSubtotalMicropesos: 5_000,
      parentTotalMicropesos: 1,
    })).toEqual({ ok: true, amount: 1 });
  });

  it.each([
    [{ impPagadoMicropesos: 0, parentSubtotalMicropesos: 100, parentTotalMicropesos: 116 }, "INVALID_PAYMENT_BASE"],
    [{ impPagadoMicropesos: 100, parentSubtotalMicropesos: -1, parentTotalMicropesos: 116 }, "INVALID_PARENT_SUBTOTAL"],
    [{ impPagadoMicropesos: 100, parentSubtotalMicropesos: 100, parentTotalMicropesos: 0 }, "INVALID_PARENT_TOTAL"],
    [{ impPagadoMicropesos: 117, parentSubtotalMicropesos: 100, parentTotalMicropesos: 116 }, "PAYMENT_EXCEEDS_PARENT_TOTAL"],
  ])("fails closed for invalid monetary inputs", (input, code) => {
    expect(proratePpdBaseCentavos(input)).toMatchObject({ ok: false, code });
  });
});

describe("allocateCentavosByBasisPoints", () => {
  it("preserves the exact total and gives the residual cent to the largest remainder", () => {
    expect(allocateCentavosByBasisPoints({
      amountCentavos: 100,
      allocations: [
        { regimenCode: "612", basisPoints: 3_333 },
        { regimenCode: "606", basisPoints: 3_333 },
        { regimenCode: "626", basisPoints: 3_334 },
      ],
    })).toEqual([
      { regimenCode: "606", basisPoints: 3_333, amountCentavos: 33 },
      { regimenCode: "612", basisPoints: 3_333, amountCentavos: 33 },
      { regimenCode: "626", basisPoints: 3_334, amountCentavos: 34 },
    ]);
  });

  it("uses regime code as a deterministic tie-break independent of input order", () => {
    expect(allocateCentavosByBasisPoints({
      amountCentavos: 1,
      allocations: [
        { regimenCode: "612", basisPoints: 5_000 },
        { regimenCode: "606", basisPoints: 5_000 },
      ],
    })).toEqual([
      { regimenCode: "606", basisPoints: 5_000, amountCentavos: 1 },
      { regimenCode: "612", basisPoints: 5_000, amountCentavos: 0 },
    ]);
  });

  it("rejects non-integer monetary units", () => {
    expect(() => allocateCentavosByBasisPoints({
      amountCentavos: 10.5,
      allocations: [{ regimenCode: "612", basisPoints: 10_000 }],
    })).toThrow(RangeError);
  });

  it("rejects an incomplete allocation set at runtime", () => {
    expect(() => allocateCentavosByBasisPoints({
      amountCentavos: 100,
      allocations: [{ regimenCode: "612", basisPoints: 9_999 }],
    })).toThrow("100.00%");
  });
});

describe("projectPpdRegimenAllocation", () => {
  it("derives an implicit 100 percent split for a single-regime invoice month", () => {
    expect(projectPpdRegimenAllocation({
      baseCentavos: 50_000,
      parentEffectiveRegimenCodes: ["612"],
      paymentEffectiveRegimenCodes: ["612", "605"],
      assignment: null,
    })).toEqual({
      ok: true,
      source: "SINGLE_REGIME_IMPLICIT",
      baseCentavos: 50_000,
      allocations: [{ regimenCode: "612", basisPoints: 10_000, amountCentavos: 50_000 }],
      usadaEnCalculoAutomatico: false,
    });
  });

  it("requires reviewed evidence for a multi-regime invoice month", () => {
    expect(projectPpdRegimenAllocation({
      baseCentavos: 50_000,
      parentEffectiveRegimenCodes: ["612", "606"],
      paymentEffectiveRegimenCodes: ["612", "606"],
      assignment: null,
    })).toMatchObject({ ok: false, code: "ASSIGNMENT_REQUIRED" });
  });

  it("projects a reviewed split to exact cents without enabling calculations", () => {
    expect(projectPpdRegimenAllocation({
      baseCentavos: 3,
      parentEffectiveRegimenCodes: ["612", "606"],
      paymentEffectiveRegimenCodes: ["606", "612"],
      assignment: { allocations: [
        { regimenCode: "612", basisPoints: 5_000 },
        { regimenCode: "606", basisPoints: 5_000 },
      ] },
    })).toMatchObject({
      ok: true,
      source: "REVIEWED_ASSIGNMENT",
      allocations: [
        { regimenCode: "606", amountCentavos: 2 },
        { regimenCode: "612", amountCentavos: 1 },
      ],
      usadaEnCalculoAutomatico: false,
    });
  });

  it("rejects stale reviewed allocations before projecting them", () => {
    expect(projectPpdRegimenAllocation({
      baseCentavos: 10_000,
      parentEffectiveRegimenCodes: ["612"],
      paymentEffectiveRegimenCodes: ["612", "626"],
      assignment: { allocations: [{ regimenCode: "626", basisPoints: 10_000 }] },
    })).toMatchObject({ ok: false, code: "REGIME_OUTSIDE_PERIOD" });
  });

  it("blocks a regime transition instead of deciding its tax treatment", () => {
    expect(projectPpdRegimenAllocation({
      baseCentavos: 10_000,
      parentEffectiveRegimenCodes: ["612"],
      paymentEffectiveRegimenCodes: ["626"],
      assignment: null,
    })).toMatchObject({
      ok: false,
      code: "REGIME_TRANSITION_REVIEW",
      regimenCodes: ["612"],
    });
  });

  it.each([
    [[], ["612"], "NO_PARENT_REGIME_EVIDENCE"],
    [["999"], ["612"], "UNKNOWN_PARENT_REGIME"],
    [["612"], [], "NO_PAYMENT_REGIME_EVIDENCE"],
    [["612"], ["999"], "UNKNOWN_PAYMENT_REGIME"],
  ])("fails closed when lifecycle evidence is absent or unknown", (parentCodes, paymentCodes, code) => {
    expect(projectPpdRegimenAllocation({
      baseCentavos: 10_000,
      parentEffectiveRegimenCodes: parentCodes,
      paymentEffectiveRegimenCodes: paymentCodes,
      assignment: null,
    })).toMatchObject({ ok: false, code });
  });
});
