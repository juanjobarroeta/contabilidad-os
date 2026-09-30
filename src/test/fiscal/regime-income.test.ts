import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decimalToSafeMicros, summarizeRegimenIncome } from "@/lib/fiscal/regimen-income-summary";
import { projectPpdRegimenAllocation } from "@/lib/fiscal/regimen-payment-allocation";
import { assertMonthlyCompanyCalculationSupported } from "@/lib/fiscal/regimen-capabilities";
import { incomeCases, incomeEvidence, incomeFixtureVersion, incomeProfessionalReview } from "./fixtures/income-v1";

describe("FISC-002M v1: independent numeric income evidence fixtures", () => {
  it("keeps stable fixture IDs and the unapproved review matrix in sync", () => {
    const matrix = readFileSync(new URL("../../../docs/fiscal/FISC-002M-INCOME-EVIDENCE-v1.md", import.meta.url), "utf8");
    const ids = incomeCases.map((entry) => entry.id).sort();
    expect(incomeProfessionalReview).toBe("PENDING");
    expect(new Set(ids).size).toBe(34);
    expect(matrix).toContain(`Fixture version: \`${incomeFixtureVersion}\``);
    expect([...matrix.matchAll(/^\| (INC-\d{3}) \|[^\n]+\| PENDING \|$/gm)].map((match) => match[1]).sort()).toEqual(ids);
  });

  it.each(incomeCases)("$id — $description", ({ input, expected }) => {
    const before = structuredClone(input);
    const result = summarizeRegimenIncome(input);
    expect(result.estado).toBe(expected.estado);
    expect(result.totales).toEqual(expected.totales);
    if (expected.porRegimen) expect(result.porRegimen).toEqual(expected.porRegimen);
    if (expected.issue) expect(result.pendientes).toContainEqual(expect.objectContaining({ code: expected.issue }));
    if (expected.duplicates !== undefined) expect(result.duplicadosOmitidos).toBe(expected.duplicates);
    expect(result.usadaEnCalculoAutomatico).toBe(false);
    expect(result.pueAcreditaCobro).toBe(false);
    if (result.estado !== "PROYECTABLE") expect(result.porRegimen).toBeNull();
    else expect(result.pendientes).toEqual([]);
    for (const row of result.renglones) {
      expect(row.allocations.reduce((sum, allocation) => sum + allocation.amountCentavos, 0)).toBe(row.baseCentavos);
      expect(row.allocations.every((allocation) => Number.isSafeInteger(allocation.amountCentavos) && allocation.amountCentavos >= 0)).toBe(true);
    }
    expect(input).toEqual(before);
  });

  it("preserves cents and regime allocations across the three payment months", () => {
    const input = incomeCases.find((c) => c.id === "INC-005")!.input;
    const results = ["2026-07", "2026-08", "2026-09"].map((period, index) => summarizeRegimenIncome({
      ...input, period, payments: [input.history[index]],
    }));
    expect(results.map((r) => r.totales?.ppdRepCentavos)).toEqual([0, 1, 0]);
    expect(results.flatMap((r) => r.porRegimen ?? []).filter((r) => r.regimenCode === "612")
      .reduce((sum, r) => sum + r.ppdRepCentavos, 0)).toBe(1);
  });

  it("withholds a parent preview when an undated payment issue was already reported", () => {
    const input = incomeEvidence();
    input.history[0].fechaPago = null;
    input.payments.push(input.history[0]);
    const result = summarizeRegimenIncome(input);
    expect(result.totales).toBeNull();
    expect(result.renglones.map((row) => row.source)).toEqual(["PUE_DOCUMENTADO"]);
    expect(result.pendientes).toContainEqual({ id: "july", code: "PAYMENT_DATE_UNAVAILABLE" });
  });

  it("does not present a conflicted duplicate parent as a valid preview", () => {
    const input = incomeCases.find((entry) => entry.id === "INC-025")!.input;
    expect(summarizeRegimenIncome(input).renglones.map((row) => row.source)).toEqual(["PUE_DOCUMENTADO"]);
  });

  it("a complete projection never unlocks a mixed monthly tax engine", () => {
    const input = incomeEvidence();
    expect(summarizeRegimenIncome(input).estado).toBe("PROYECTABLE");
    expect(() => assertMonthlyCompanyCalculationSupported({ regimenFiscal: null, regimenes: input.regimenCodes, tipoPersona: "PF" }))
      .toThrow(expect.objectContaining({ code: "NOT_SUPPORTED", reason: "MULTI_REGIME_COMPOSITION_REQUIRED" }));
  });

  it("the existing per-payment projection still rejects zero", () => {
    expect(projectPpdRegimenAllocation({ baseCentavos: 0, parentEffectiveRegimenCodes: ["612"], paymentEffectiveRegimenCodes: ["612"], assignment: null }))
      .toMatchObject({ ok: false, code: "INVALID_PAYMENT_BASE" });
  });

  it.each([
    ["2026-08-01T00:00:00Z", "PROYECTABLE"],
    ["2026-09-01T00:00:00Z", "SIN_EVIDENCIA"],
    ["2026-07-31T23:59:59.999Z", "SIN_EVIDENCIA"],
  ])("uses half-open UTC emission bounds for %s", (fecha, estado) => {
    const input = incomeEvidence();
    input.parents = []; input.payments = []; input.history = [];
    input.issued[0].fecha = fecha;
    expect(summarizeRegimenIncome(input).estado).toBe(estado);
  });
});

describe("Decimal storage precision", () => {
  it.each([
    ["0", 0], ["0.000001", 1], ["1044.000000", 1_044_000_000],
    ["9007199254.740991", Number.MAX_SAFE_INTEGER], ["9007199254.740992", null],
    ["-1", null], ["NaN", null], ["1e3", null], ["0.0000001", null], ["", null], [null, null],
  ])("parses %s exactly or fails closed", (raw, expected) => {
    expect(decimalToSafeMicros(raw as string | null)).toBe(expected);
  });
});
