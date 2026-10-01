import { describe, expect, it } from "vitest";
import { compareRepPayment, parseRepPaymentEvidence, repCalendarIso, REP_XML_MAX_BYTES } from "@/lib/fiscal/rep-payment-evidence";
import type { RegimenPaymentEvidence } from "@/lib/fiscal/regimen-document-bases";
import { repFixture as fixture, repXml } from "./fixtures/rep-payment-v1";
import { repXmlWithinBudget, REP_CHECK_MAX_DOCUMENTS, REP_CHECK_MAX_TOTAL_BYTES } from "@/lib/fiscal/deduction-payment-evidence";

const payment: RegimenPaymentEvidence = { id: "relation", repInvoiceId: "rep", repUuid: fixture.repUuid, parentUuid: fixture.parentUuid,
  fechaPago: `${fixture.date}.000Z`, amountMicros: 58_000_000, installment: 1, status: "STAMPED", supersededBy: null };
const check = (xml = repXml(), patch: Partial<RegimenPaymentEvidence> = {}, supplier: string | null = fixture.supplierRfc) =>
  compareRepPayment(parseRepPaymentEvidence(xml), { ...payment, ...patch }, fixture.companyRfc, supplier);

describe("FISC-002P stored REP source comparison (not payment/deduction approval)", () => {
  it("compares the right Pago/Docto without floats and retains the source calendar date", () => {
    expect(check()).toEqual({ estado: "COTEJADO", motivo: null, fechaPago: fixture.date, formaDePagoP: "03",
      monedaP: "MXN", monedaDR: "MXN", impPagado: "58.000000", parcialidad: 1 });
  });
  it("is independent of namespace prefixes, quote style and XML comments", () => {
    const xml = repXml({ note: "<!-- <p:Pago FormaDePagoP='01'/> -->" }).replace(/(<\/?)(p:)/g, "$1pay:").replaceAll("xmlns:p=", "xmlns:pay=").replaceAll('"', "'");
    expect(check(xml).estado).toBe("COTEJADO");
  });
  it.each(["01", "02", "17", "03", "28"])("reports %s as source data without approving its legal treatment", (method) => {
    expect(check(repXml({ method }))).toMatchObject({ estado: "COTEJADO", formaDePagoP: method });
    expect(check(repXml({ method }))).not.toHaveProperty("deduccionAutorizadaCentavos");
  });
  it.each(["99", "", "3", "00", "77"])("does not guess unavailable/unknown payment method %s", (method) => {
    expect(check(repXml({ method }))).toEqual({ estado: "PENDIENTE", motivo: "PAYMENT_METHOD_REVIEW" });
  });
  it.each(["companyRfc", "supplierRfc", "repUuid"] as const)("rejects another %s", (field) => {
    expect(check(repXml({ [field]: "OTHER" }))).toMatchObject({ estado: "PENDIENTE", motivo: "IDENTITY_MISMATCH" });
  });
  it("requires a known supplier rather than accepting an arbitrary REP issuer", () => {
    expect(check(repXml(), {}, null)).toMatchObject({ motivo: "SUPPLIER_MISSING" });
  });
  it.each([{ status: "CANCELLED" }, { status: "DRAFT" }, { supersededBy: "replacement" }])("rejects a noncurrent REP %j", (patch) => {
    expect(check(repXml(), patch)).toMatchObject({ motivo: "REP_NOT_CURRENT" });
  });
  it("does not call malformed matching identifiers corroborated", () => {
    expect(check(repXml({ repUuid: "not-a-folio" }), { repUuid: "not-a-folio" })).toMatchObject({ motivo: "IDENTITY_MISMATCH" });
    expect(compareRepPayment(parseRepPaymentEvidence(repXml({ companyRfc: "" })), payment, "", fixture.supplierRfc)).toMatchObject({ motivo: "IDENTITY_MISMATCH" });
  });
  it("cannot substitute a related invoice UUID for the stamped REP UUID", () => {
    const xml = repXml().replace("<cfdi:Complemento>", `<cfdi:CfdiRelacionados><cfdi:CfdiRelacionado UUID="${fixture.repUuid}"/></cfdi:CfdiRelacionados><cfdi:Complemento>`)
      .replace(`<t:TimbreFiscalDigital UUID="${fixture.repUuid}"`, `<t:TimbreFiscalDigital UUID="${fixture.parentUuid}"`);
    expect(check(xml)).toMatchObject({ motivo: "IDENTITY_MISMATCH" });
  });
  it.each([{ parentUuid: "CCCCCCCC-3333-4333-8333-333333333333" }, { fechaPago: "2026-09-11T12:00:00.000Z" }, { amountMicros: 58_000_001 }, { installment: 2 }])("requires an exact stored relation match %j", (patch) => {
    expect(check(repXml(), patch).estado).toBe("PENDIENTE");
  });
  it("does not coerce invalid decimals into a plausible amount", () => {
    expect(check(repXml({ paid: "58junk" }))).toMatchObject({ motivo: "PAYMENT_MISMATCH" });
    expect(check(repXml({ paid: "58.0000001" }))).toMatchObject({ motivo: "PAYMENT_MISMATCH" });
  });
  it.each([{ currency: "USD" }, { documentCurrency: "USD" }, { equivalence: "2" }])("leaves currency conversion to review %j", (patch) => {
    expect(check(repXml(patch))).toMatchObject({ motivo: "CURRENCY_REVIEW" });
  });
  it("requires exact local balance arithmetic and a sufficient payment-node amount", () => {
    expect(check(repXml({ after: "58.000001" }))).toMatchObject({ motivo: "AMOUNT_REVIEW" });
    expect(check(repXml().replace('Monto="58.000000"', 'Monto="57"'))).toMatchObject({ motivo: "AMOUNT_REVIEW" });
  });
  it("requires review when one XML has multiple payments for the same parent", () => {
    const extraPago = `<p:Pago FechaPago="2026-09-11T12:00:00" FormaDePagoP="28" MonedaP="MXN" Monto="58"><p:DoctoRelacionado IdDocumento="${fixture.parentUuid}"/></p:Pago>`;
    expect(check(repXml({ extraPago }))).toMatchObject({ motivo: "RELATION_AMBIGUOUS" });
  });
  it("binds the method to the payment node, not another invoice/payment", () => {
    const extraPago = '<p:Pago FechaPago="2026-09-11T12:00:00" FormaDePagoP="28" MonedaP="MXN" Monto="1"><p:DoctoRelacionado IdDocumento="CCCCCCCC-3333-4333-8333-333333333333" ImpPagado="1"/></p:Pago>';
    expect(check(repXml({ extraPago }))).toMatchObject({ estado: "COTEJADO", formaDePagoP: "03" });
  });
  it.each([null, "", "  "])("handles absent XML as unknown, not zero or success", (xml) => {
    expect(parseRepPaymentEvidence(xml)).toEqual({ ok: false, reason: "XML_MISSING" });
  });
  it.each([
    repXml().replace("</cfdi:Comprobante>", ""), repXml().replace('Version="4.0"', 'Version="4.0" Version="4.0"'),
    '<!DOCTYPE cfdi:Comprobante [<!ENTITY x SYSTEM "https://forbidden.invalid">]>' + repXml(),
    repXml().replace(fixture.supplierRfc, "&unknown;"), repXml().replace('xmlns:p="http://www.sat.gob.mx/Pagos20"', 'xmlns:p="https://hostile.invalid"'),
    repXml().replace("<cfdi:Complemento>", "<cfdi:Complemento/><cfdi:Complemento>"),
  ])("fails closed on malformed, hostile or ambiguous XML", (xml) => {
    expect(parseRepPaymentEvidence(xml)).toEqual({ ok: false, reason: "XML_INVALID" });
  });
  it("bounds source size and node count before DOM parsing", () => {
    expect(parseRepPaymentEvidence("x".repeat(REP_XML_MAX_BYTES + 1))).toMatchObject({ reason: "XML_LIMIT" });
    expect(parseRepPaymentEvidence("<a/>".repeat(10001))).toMatchObject({ reason: "XML_INVALID" });
  });
  it("enforces document, per-XML and aggregate byte budgets without partial success", () => {
    expect(repXmlWithinBudget(REP_CHECK_MAX_DOCUMENTS, [REP_XML_MAX_BYTES])).toBe(true);
    expect(repXmlWithinBudget(REP_CHECK_MAX_DOCUMENTS + 1, [1])).toBe(false);
    expect(repXmlWithinBudget(1, [REP_XML_MAX_BYTES + 1])).toBe(false);
    const sizes = Array.from({ length: REP_CHECK_MAX_TOTAL_BYTES / REP_XML_MAX_BYTES }, () => REP_XML_MAX_BYTES);
    expect(repXmlWithinBudget(sizes.length, sizes)).toBe(true);
    expect(repXmlWithinBudget(sizes.length + 1, [...sizes, 1])).toBe(false);
    expect(repXmlWithinBudget(1, [NaN])).toBe(false);
  });
  it("does not silently support a legacy version", () => {
    expect(parseRepPaymentEvidence(repXml().replace('Version="4.0"', 'Version="3.3"'))).toMatchObject({ reason: "VERSION_REVIEW" });
    expect(parseRepPaymentEvidence(repXml().replace('Version="2.0"', 'Version="1.0"'))).toMatchObject({ reason: "VERSION_REVIEW" });
  });
  it.each(["2026-02-30T12:00:00", "2026-09-10T24:00:00", "2026-09-10", "2026-09-10T12:00:00Z", "2026-09-10T12:00:00-06:00"])("rejects noncanonical or invalid calendar time %s", (date) => {
    expect(repCalendarIso(date)).toBeNull();
    expect(check(repXml({ date }))).toMatchObject({ motivo: "PAYMENT_MISMATCH" });
  });
  it("keeps a month boundary stable in UTC and Mexico City", () => {
    const date = "2026-09-01T00:00:00";
    expect(repCalendarIso(date)).toBe("2026-09-01T00:00:00.000Z");
    expect(check(repXml({ date }), { fechaPago: "2026-09-01T00:00:00.000Z" }).estado).toBe("COTEJADO");
  });
});
