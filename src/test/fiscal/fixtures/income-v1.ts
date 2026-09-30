import type { RegimenIncomeInput, RegimenIncomeSummary, IncomeSummaryIssueCode } from "@/lib/fiscal/regimen-income-summary";

export const incomeFixtureVersion = "2026-09-30.1";
export const incomeProfessionalReview = "PENDING";
export const PPD_UUID = "00000000-0000-4000-8000-000000000001";
export const PUE_UUID = "00000000-0000-4000-8000-000000000002";

/** Independent synthetic facts: net invoice 900, total 1044; payments 261/522/261. */
export function incomeEvidence(): RegimenIncomeInput {
  const assignment = { revision: 2, allocations: [
    { regimenCode: "606", basisPoints: 4000 }, { regimenCode: "612", basisPoints: 6000 },
  ] };
  const parent = {
    id: "ppd", uuid: PPD_UUID, fecha: "2026-07-01T00:00:00Z", tipo: "INGRESO", tipoSat: "I",
    status: "STAMPED", supersededBy: null, metodoPago: "PPD", moneda: "MXN", subtotalMicros: 1_000_000_000,
    descuentoMicros: 100_000_000, totalMicros: 1_044_000_000,
    regimenCodes: ["606", "612"], assignment,
  };
  const history = [
    { id: "july", parentUuid: PPD_UUID, repUuid: "aaaaaaaa-0000-4000-8000-000000000001", status: "STAMPED", fechaPago: "2026-07-15T12:00:00Z", amountMicros: 261_000_000, installment: 1 },
    { id: "august", parentUuid: PPD_UUID, repUuid: "aaaaaaaa-0000-4000-8000-000000000002", status: "STAMPED", fechaPago: "2026-08-15T12:00:00Z", amountMicros: 522_000_000, installment: 2 },
    { id: "september", parentUuid: PPD_UUID, repUuid: "aaaaaaaa-0000-4000-8000-000000000003", status: "STAMPED", fechaPago: "2026-09-15T12:00:00Z", amountMicros: 261_000_000, installment: 3 },
  ].map((payment) => ({ ...payment, supersededBy: null }));
  return structuredClone({
    period: "2026-08", regimenCodes: ["606", "612"], truncated: false, linkedCreditNoteIds: [],
    issued: [{ ...parent, id: "pue", uuid: PUE_UUID, fecha: "2026-08-10T12:00:00Z", metodoPago: "PUE",
      subtotalMicros: 100_000_000, descuentoMicros: 10_000_000, totalMicros: 104_400_000 }],
    parents: [parent], payments: [history[1]], history,
  });
}

function change(edit: (input: RegimenIncomeInput) => void) {
  const input = incomeEvidence();
  edit(input);
  return input;
}

interface IncomeCase {
  id: string;
  description: string;
  input: RegimenIncomeInput;
  expected: {
    estado: RegimenIncomeSummary["estado"];
    totales: RegimenIncomeSummary["totales"];
    porRegimen?: RegimenIncomeSummary["porRegimen"];
    issue?: IncomeSummaryIssueCode;
    duplicates?: number;
  };
}
const normal = {
  estado: "PROYECTABLE" as const,
  totales: { pueDocumentadoCentavos: 9000, ppdRepCentavos: 45000 },
  porRegimen: [
    { regimenCode: "606", pueDocumentadoCentavos: 3600, ppdRepCentavos: 18000 },
    { regimenCode: "612", pueDocumentadoCentavos: 5400, ppdRepCentavos: 27000 },
  ],
};
const pending = (issue: IncomeSummaryIssueCode): IncomeCase["expected"] => ({ estado: "PENDIENTE", totales: null, issue });

export const incomeCases: readonly IncomeCase[] = [
  { id: "INC-001", description: "Discounted PUE and partial PPD remain separate exact buckets", input: incomeEvidence(), expected: normal },
  { id: "INC-002", description: "PPD-only month counts the payment, not the issued invoice", input: change((i) => { i.issued = []; }),
    expected: { estado: "PROYECTABLE", totales: { pueDocumentadoCentavos: 0, ppdRepCentavos: 45000 } } },
  { id: "INC-003", description: "Duplicate REP import with the same fiscal identity is counted once", input: change((i) => {
    const copy = { ...i.payments[0], id: "z-copy", repUuid: i.payments[0].repUuid!.toUpperCase() };
    i.payments.push(copy); i.history.push(copy);
  }), expected: { ...normal, duplicates: 1 } },
  { id: "INC-004", description: "Query and allocation order cannot change amounts", input: change((i) => {
    i.history.reverse(); i.parents[0].assignment!.allocations.reverse(); i.issued[0].assignment!.allocations.reverse();
  }), expected: normal },
  { id: "INC-005", description: "Three tiny partial payments conserve the cumulative cent", input: change((i) => {
    i.issued = []; Object.assign(i.parents[0], { subtotalMicros: 10_000, descuentoMicros: 0, totalMicros: 30_000 });
    i.history.forEach((p) => { p.amountMicros = 10_000; }); i.payments[0].amountMicros = 10_000;
  }), expected: { estado: "PROYECTABLE", totales: { pueDocumentadoCentavos: 0, ppdRepCentavos: 1 },
    porRegimen: [{ regimenCode: "606", pueDocumentadoCentavos: 0, ppdRepCentavos: 0 }, { regimenCode: "612", pueDocumentadoCentavos: 0, ppdRepCentavos: 1 }] } },
  { id: "INC-006", description: "Final tiny payment does not invent another residual cent", input: change((i) => {
    i.issued = []; i.period = "2026-09";
    Object.assign(i.parents[0], { subtotalMicros: 10_000, descuentoMicros: 0, totalMicros: 30_000 });
    i.history.forEach((p) => { p.amountMicros = 10_000; }); i.payments = [i.history[2]];
  }), expected: { estado: "PROYECTABLE", totales: { pueDocumentadoCentavos: 0, ppdRepCentavos: 0 } } },
  { id: "INC-007", description: "Half-cent rounding and tied shares use stable regime order", input: change((i) => {
    i.payments = []; i.history = []; i.parents = [];
    Object.assign(i.issued[0], { subtotalMicros: 5_000, descuentoMicros: 0, totalMicros: 5_800,
      assignment: { revision: 1, allocations: [{ regimenCode: "612", basisPoints: 5000 }, { regimenCode: "606", basisPoints: 5000 }] } });
  }), expected: { estado: "PROYECTABLE", totales: { pueDocumentadoCentavos: 1, ppdRepCentavos: 0 },
    porRegimen: [{ regimenCode: "606", pueDocumentadoCentavos: 1, ppdRepCentavos: 0 }, { regimenCode: "612", pueDocumentadoCentavos: 0, ppdRepCentavos: 0 }] } },
  { id: "INC-008", description: "No evidence is null, never a verified zero", input: change((i) => { i.issued = []; i.payments = []; i.history = []; i.parents = []; }),
    expected: { estado: "SIN_EVIDENCIA", totales: null } },
  { id: "INC-009", description: "Cancelled PUE and REP documents do not create income", input: change((i) => {
    i.issued[0].status = "CANCELLED"; i.payments[0].status = "CANCELLED";
  }), expected: { estado: "SIN_EVIDENCIA", totales: null } },
  { id: "INC-010", description: "A live REP linked to a cancelled parent requires review", input: change((i) => { i.parents[0].status = "CANCELLED"; }), expected: pending("PARENT_NOT_ELIGIBLE") },
  { id: "INC-011", description: "PPD emission in the same month is not counted a second time", input: change((i) => {
    i.parents[0].fecha = "2026-08-01T00:00:00Z"; i.history.shift();
    i.history[0].installment = 1; i.history[1].installment = 2;
    i.issued.push({ ...i.parents[0] });
  }), expected: normal },
  { id: "INC-012", description: "Mixed-regime income requires reviewed shares", input: change((i) => { i.parents[0].assignment = null; }), expected: pending("ASSIGNMENT_REQUIRED") },
  { id: "INC-013", description: "An unresolved parent is not silently omitted", input: change((i) => { i.parents = []; }), expected: pending("PARENT_NOT_FOUND") },
  { id: "INC-014", description: "Ambiguous normalized parent UUID blocks totals", input: change((i) => { i.parents.push({ ...i.parents[0], id: "other-parent" }); }), expected: pending("AMBIGUOUS_INVOICE_UUID") },
  { id: "INC-015", description: "Current payment must exist in the all-period snapshot", input: change((i) => { i.history.splice(1, 1); }), expected: pending("PAYMENT_SNAPSHOT_MISMATCH") },
  { id: "INC-016", description: "Cumulative stamped overpayment blocks every total", input: change((i) => { i.history[2].amountMicros = 262_000_000; }), expected: pending("CUMULATIVE_PAYMENT_EXCEEDS_PARENT_TOTAL") },
  { id: "INC-017", description: "Cancelled historical REP cannot cause a false overpayment", input: change((i) => {
    i.history.push({ ...i.history[0], id: "cancelled", repUuid: "cancelled-rep", amountMicros: 9_000_000_000, status: "CANCELLED" });
  }), expected: normal },
  { id: "INC-018", description: "Missing historical amount is not zero", input: change((i) => { i.history[0].amountMicros = null; }), expected: pending("PAYMENT_HISTORY_AMOUNT_UNAVAILABLE") },
  { id: "INC-019", description: "Missing payment date cannot disappear from coverage", input: change((i) => { i.payments[0].fechaPago = null; }), expected: pending("PAYMENT_DATE_UNAVAILABLE") },
  { id: "INC-020", description: "Discount greater than subtotal is invalid, not clamped to zero", input: change((i) => { i.parents[0].descuentoMicros = 2_000_000_000; }), expected: pending("INVALID_INVOICE_AMOUNTS") },
  { id: "INC-021", description: "Foreign-currency evidence remains outside this contract", input: change((i) => { i.parents[0].moneda = "USD"; }), expected: pending("FOREIGN_CURRENCY_REVIEW") },
  { id: "INC-022", description: "Linked credit notes block totals until netting rules are reviewed", input: change((i) => { i.linkedCreditNoteIds = ["credit-note"]; }), expected: pending("CREDIT_NOTE_REVIEW") },
  { id: "INC-023", description: "Non-monotone cumulative allocation requires review, not negative income", input: change((i) => {
    i.issued = []; i.regimenCodes = ["606", "612", "626"];
    Object.assign(i.parents[0], { subtotalMicros: 90_000, descuentoMicros: 0, totalMicros: 90_000,
      regimenCodes: ["606", "612", "626"], assignment: { revision: 1, allocations: [
        { regimenCode: "606", basisPoints: 5556 }, { regimenCode: "612", basisPoints: 3333 }, { regimenCode: "626", basisPoints: 1111 },
      ] } });
    i.history[0].amountMicros = 40_000; i.history[1].amountMicros = 10_000; i.history[2].amountMicros = 40_000;
    i.payments[0].amountMicros = 10_000;
  }), expected: pending("CUMULATIVE_ROUNDING_REVIEW") },
  { id: "INC-024", description: "Payment before parent issuance is not assigned automatically", input: change((i) => { i.parents[0].fecha = "2026-07-20T00:00:00Z"; }), expected: pending("PAYMENT_BEFORE_INVOICE") },
  { id: "INC-025", description: "Contradictory duplicate REP imports block totals", input: change((i) => { i.payments.push({ ...i.payments[0], id: "copy", amountMicros: 521_000_000 }); }), expected: pending("DUPLICATE_PAYMENT_CONFLICT") },
  { id: "INC-026", description: "Repeated installment number across stamped REP requires review", input: change((i) => { i.history[0].installment = 2; }), expected: pending("DUPLICATE_INSTALLMENT") },
  { id: "INC-027", description: "Incomplete scan cannot produce partial-looking complete totals", input: change((i) => { i.truncated = true; }), expected: pending("EVIDENCE_LIMIT_EXCEEDED") },
  { id: "INC-028", description: "Regime transition between issuance and collection remains blocked", input: change((i) => { i.regimenCodes = ["612"]; }), expected: pending("REGIME_TRANSITION_REVIEW") },
  { id: "INC-029", description: "Single-regime evidence uses implicit full attribution", input: change((i) => {
    i.regimenCodes = ["612"];
    for (const row of [...i.issued, ...i.parents]) { row.regimenCodes = ["612"]; row.assignment = null; }
  }), expected: { estado: "PROYECTABLE", totales: { pueDocumentadoCentavos: 9000, ppdRepCentavos: 45000 },
    porRegimen: [{ regimenCode: "612", pueDocumentadoCentavos: 9000, ppdRepCentavos: 45000 }] } },
  { id: "INC-030", description: "A known zero net PUE base is distinct from missing evidence", input: change((i) => {
    i.parents = []; i.payments = []; i.history = []; i.issued[0].descuentoMicros = 100_000_000; i.issued[0].totalMicros = 0;
  }), expected: { estado: "PROYECTABLE", totales: { pueDocumentadoCentavos: 0, ppdRepCentavos: 0 } } },
  { id: "INC-031", description: "Superseded REP is excluded even when still stamped", input: change((i) => {
    const replaced = { ...i.payments[0], id: "replaced", repUuid: "replaced-rep", supersededBy: i.payments[0].repUuid };
    i.payments.push(replaced); i.history.push(replaced);
  }), expected: normal },
  { id: "INC-032", description: "Superseded PUE cannot duplicate its replacement", input: change((i) => {
    i.issued.push({ ...i.issued[0], id: "replaced-pue", uuid: "replaced-pue-uuid", supersededBy: i.issued[0].uuid });
  }), expected: normal },
  { id: "INC-033", description: "Missing installment number leaves history unverified", input: change((i) => {
    i.history[0].installment = null;
  }), expected: pending("PAYMENT_INSTALLMENT_UNAVAILABLE") },
  { id: "INC-034", description: "A gap in installment history cannot be treated as complete", input: change((i) => {
    i.history.shift();
  }), expected: pending("PAYMENT_HISTORY_GAP") },
];
