import { describe, expect, it } from "vitest";
import { readBankLocation } from "./navigation";

describe("Bancos deep links", () => {
  it("resolves chat destinations and browser back without a page remount", () => {
    expect(readBankLocation("").tab).toBe("conciliacion");
    expect(readBankLocation("tab=movimientos").tab).toBe("movimientos");
    expect(readBankLocation("tab=cuentas").tab).toBe("cuentas");
    expect(readBankLocation("").tab).toBe("conciliacion");
  });
  it("only selects a transaction with a complete valid period in reconciliation", () => {
    expect(readBankLocation("year=2026&month=9&tx=bank-1")).toEqual({ tab: "conciliacion", period: { year: 2026, month: 9 }, tx: "bank-1" });
    for (const query of ["year=2026&tx=bank-1", "year=2026&month=13&tx=bank-1", "year=2026.5&month=9&tx=bank-1"]) {
      expect(readBankLocation(query).tx).toBeNull();
    }
    expect(readBankLocation("tab=movimientos&year=2026&month=9&tx=bank-1").tx).toBeNull();
  });
});
