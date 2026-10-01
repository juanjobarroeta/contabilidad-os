export type BankTab = "conciliacion" | "movimientos" | "cuentas" | "historico";

/** Shared route contract for chat links, tabs, and browser back/forward. */
export function readBankLocation(query: string) {
  const params = new URLSearchParams(query);
  const value = params.get("tab");
  const tab: BankTab = value === "movimientos" || value === "cuentas" || value === "historico" ? value : "conciliacion";
  const year = Number(params.get("year")), month = Number(params.get("month"));
  const validPeriod = Number.isInteger(year) && year >= 2000 && year <= 2100 && Number.isInteger(month) && month >= 1 && month <= 12;
  return { tab, period: validPeriod ? { year, month } : null, tx: validPeriod && tab === "conciliacion" ? params.get("tx") : null };
}
