import type { EntryType } from "@prisma/client";

export type LoanFamily = "LOAN_GIVEN" | "LOAN_RECEIVED";
export function validLoanAccount(family: LoanFamily, account: { tipo: string; naturaleza: string | null; codAgrup: string | null }) {
  // SAT group 107: debtors, 205/251: short/long-term creditors. A customer's
  // custom number such as 1170 is not itself an official SAT grouping code.
  return family === "LOAN_GIVEN"
    ? account.tipo === "ACTIVO" && account.naturaleza !== "A" && /^107(?:\.|$)/.test(account.codAgrup ?? "")
    : account.tipo === "PASIVO" && account.naturaleza !== "D" && /^(205|251)(?:\.|$)/.test(account.codAgrup ?? "");
}
export function loanLines(bankAccountId: string, counterAccountId: string, amount: number): Array<{ chartAccountId: string; tipo: EntryType; monto: number }> {
  if (!Number.isFinite(amount) || amount === 0 || bankAccountId === counterAccountId) throw new Error("Invalid loan posting");
  return [
    { chartAccountId: bankAccountId, tipo: amount > 0 ? "CARGO" : "ABONO", monto: Math.abs(amount) },
    { chartAccountId: counterAccountId, tipo: amount > 0 ? "ABONO" : "CARGO", monto: Math.abs(amount) },
  ];
}
