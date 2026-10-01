import { describe, expect, it } from "vitest";
import { loanLines, validLoanAccount } from "./loan-posting";

describe("loan capital posting", () => {
  it("preserves the chosen counteraccount and balances both disbursements and repayments", () => {
    expect(loanLines("bank", "debtor", -70941.74)).toEqual([
      { chartAccountId: "bank", tipo: "ABONO", monto: 70941.74 }, { chartAccountId: "debtor", tipo: "CARGO", monto: 70941.74 },
    ]);
    expect(loanLines("bank", "debtor", 35000)).toEqual([
      { chartAccountId: "bank", tipo: "CARGO", monto: 35000 }, { chartAccountId: "debtor", tipo: "ABONO", monto: 35000 },
    ]);
    expect(() => loanLines("bank", "bank", 10)).toThrow();
    expect(() => loanLines("bank", "debtor", NaN)).toThrow();
  });
  it("does not confuse custom numbers, income, or opposite balances with a loan account", () => {
    expect(validLoanAccount("LOAN_GIVEN", { tipo: "ACTIVO", naturaleza: "D", codAgrup: "107.05" })).toBe(true);
    expect(validLoanAccount("LOAN_RECEIVED", { tipo: "PASIVO", naturaleza: "A", codAgrup: "205.04" })).toBe(true);
    expect(validLoanAccount("LOAN_RECEIVED", { tipo: "PASIVO", naturaleza: "A", codAgrup: "251.02" })).toBe(true);
    expect(validLoanAccount("LOAN_RECEIVED", { tipo: "PASIVO", naturaleza: "A", codAgrup: "206.01" })).toBe(false);
    for (const codAgrup of [null, "1170", "102.01", "401.01"]) expect(validLoanAccount("LOAN_GIVEN", { tipo: "ACTIVO", naturaleza: "D", codAgrup })).toBe(false);
    expect(validLoanAccount("LOAN_GIVEN", { tipo: "PASIVO", naturaleza: "A", codAgrup: "205.04" })).toBe(false);
  });
});
