import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertMonthlyCompanyCalculationSupported } from "@/lib/fiscal/regimen-capabilities";
import { summarizeRegimenDeductions, DEDUCTION_REVIEW_REASONS } from "@/lib/fiscal/regimen-deduction-summary";
import { summarizeRegimenIncome } from "@/lib/fiscal/regimen-income-summary";
import { incomeCases } from "./fixtures/income-v1";
import { deductionCases, deductionEvidence, deductionFixtureVersion, deductionProfessionalReview } from "./fixtures/deduction-v1";

describe("FISC-002N deduction documentary allocation and eligibility review", () => {
  it.each(deductionCases)("$id — $description", ({ input, tipoPersona, expected }) => {
    const before = structuredClone(input);
    const result = summarizeRegimenDeductions(input, tipoPersona);
    expect(result.documental.estado).toBe(expected.estado);
    expect(result.documental.totales).toEqual(expected.totales);
    if (expected.issue) expect(result.documental.pendientes).toContainEqual(expect.objectContaining({ code: expected.issue }));
    const reviews = result.renglones.flatMap((row) => row.elegibilidad);
    if (expected.reason) expect(reviews.flatMap((review) => review.motivos)).toContain(expected.reason);
    if (expected.treatment) expect(reviews.map((review) => review.tratamiento)).toContain(expected.treatment);
    expect(result.estado).toBe(expected.estado === "SIN_EVIDENCIA" ? "SIN_EVIDENCIA" : "PENDIENTE");
    expect(result.deduccionAutorizadaCentavos).toBeNull();
    expect(result.usadaEnCalculoAutomatico).toBe(false);
    expect(result.pueAcreditaPago).toBe(false);
    for (const review of reviews) {
      expect(review.estado).toBe("PENDIENTE"); expect(review.deduccionAutorizadaCentavos).toBeNull();
      expect(review.motivos.length).toBeGreaterThan(0);
      for (const reason of review.motivos) expect(DEDUCTION_REVIEW_REASONS[reason]).toBeTruthy();
    }
    expect(input).toEqual(before);
  });

  it.each(incomeCases)("shared numeric/integrity guard on expenses: $id", ({ input, expected }) => {
    const expenseInput = structuredClone(input);
    for (const invoice of [...expenseInput.issued, ...expenseInput.parents]) invoice.tipo = "EGRESO";
    const result = summarizeRegimenDeductions(expenseInput, "PF");
    expect(result.documental.estado).toBe(expected.estado);
    expect(result.documental.totales).toEqual(expected.totales);
    if (expected.porRegimen) expect(result.documental.porRegimen).toEqual(expected.porRegimen);
    if (expected.issue) expect(result.documental.pendientes).toContainEqual(expect.objectContaining({ code: expected.issue }));
    if (expected.duplicates !== undefined) expect(result.documental.duplicadosOmitidos).toBe(expected.duplicates);
  });

  it("keeps direction isolation symmetric without fabricating deducted income", () => {
    expect(summarizeRegimenIncome(deductionEvidence())).toMatchObject({ estado: "SIN_EVIDENCIA", totales: null, renglones: [] });
  });

  it("rental review does not contaminate the other regime's checklist", () => {
    const reviews = summarizeRegimenDeductions(deductionEvidence(), "PF").renglones.flatMap((row) => row.elegibilidad);
    for (const review of reviews) expect(review.motivos.includes("RENTAL_ELECTION_REVIEW")).toBe(review.regimenCode === "606");
  });

  it("PPD never trusts a parent's electronic payment method as REP payment-method evidence", () => {
    const result = summarizeRegimenDeductions(deductionEvidence(), "PF");
    const ppd = result.renglones.find((row) => row.source === "PPD_REP")!;
    expect(ppd.elegibilidad.every((review) => review.motivos.includes("PPD_PAYMENT_METHOD_UNAVAILABLE"))).toBe(true);
  });

  it("source conflicts remain visible even after a manual classification", () => {
    const input = deductionCases.find((entry) => entry.id === "DED-010")!.input;
    expect(summarizeRegimenDeductions(input, "PF").renglones.every((row) => row.clasificacion.requiereRevision)).toBe(true);
  });

  it("conflicting copies of the same invoice cannot generate an eligibility preview", () => {
    const input = deductionEvidence();
    input.parents.push({ ...input.issued[0], expense: { ...input.issued[0].expense!, naturaleza: "INVERSION" } });
    const result = summarizeRegimenDeductions(input, "PF");
    expect(result.documental.totales).toBeNull();
    expect(result.documental.pendientes).toContainEqual({ id: input.issued[0].id, code: "AMBIGUOUS_INVOICE_UUID" });
    expect(result.renglones.some((row) => row.invoiceId === input.issued[0].id)).toBe(false);
  });

  it("RESICO PM never gets the PF no-ISR-deduction label", () => {
    const input = deductionCases.find((entry) => entry.id === "DED-015")!.input;
    const reviews = summarizeRegimenDeductions(input, "PM").renglones.flatMap((row) => row.elegibilidad);
    expect(reviews.every((review) => !review.motivos.includes("RESICO_PF_NO_ISR_DEDUCTION"))).toBe(true);
  });

  it("a documentary projection cannot unlock the mixed-regime tax engine", () => {
    const input = deductionEvidence();
    expect(summarizeRegimenDeductions(input, "PF").documental.estado).toBe("PROYECTABLE");
    expect(() => assertMonthlyCompanyCalculationSupported({ regimenFiscal: null, regimenes: input.regimenCodes, tipoPersona: "PF" }))
      .toThrow(expect.objectContaining({ code: "NOT_SUPPORTED", reason: "MULTI_REGIME_COMPOSITION_REQUIRED" }));
  });

  it("ties the 30 stable scenarios to an explicitly unapproved versioned matrix", () => {
    const matrix = readFileSync(new URL("../../../docs/fiscal/FISC-002N-DEDUCTION-EVIDENCE-v1.md", import.meta.url), "utf8");
    const ids = deductionCases.map((entry) => entry.id).sort();
    expect(new Set(ids).size).toBe(30);
    expect(deductionProfessionalReview).toBe("PENDING");
    expect(matrix).toContain(`Fixture version: \`${deductionFixtureVersion}\``);
    expect([...matrix.matchAll(/^\| (DED-\d{3}) \|[^\n]+\| PENDING \|$/gm)].map((match) => match[1]).sort()).toEqual(ids);
  });
});
