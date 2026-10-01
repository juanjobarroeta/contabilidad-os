import { describe, expect, it } from "vitest";
import { capabilityCatalogue, managedTools, validateToolInput } from "./capabilities";

describe("ContaBot capabilities", () => {
  it("gives a viewer reads and presentation, never writes or the operator connector", () => {
    const names = managedTools(false).flatMap((t) => t.type === "function" ? [t.name] : []);
    expect(names).toContain("query_bank_transactions");
    for (const name of ["proponer_conciliacion", "registrar_hecho", "anotar_expediente", "cerrar_pendiente",
      "solicitar_al_cliente", "query_despacho_panorama", "empujar_cron", "preview_factura"]) {
      expect(names).not.toContain(name);
    }
    expect(capabilityCatalogue(true).capabilities.find((c) => c.name === "proponer_conciliacion"))
      .toMatchObject({ execution: "requires_user_confirmation" });
  });

  it("rejects model-selected company/auth scope and malformed arguments before execution", async () => {
    await expect(validateToolInput("query_invoices", { companyId: "other-company" })).rejects.toThrow("INVALID_ARGUMENTS");
    await expect(validateToolInput("proponer_conciliacion", { transaction_id: "t" })).rejects.toThrow("INVALID_ARGUMENTS");
    await expect(validateToolInput("suggest_reconciliation_match", { transaction_id: 42 })).rejects.toThrow("INVALID_ARGUMENTS");
    await expect(validateToolInput("query_invoices", { limit: 100000 })).rejects.toThrow("INVALID_LIMIT");
    await expect(validateToolInput("constructor", {})).rejects.toThrow("TOOL_NOT_AVAILABLE");
    await expect(validateToolInput("proponer_conciliacion", { transaction_id: "t", invoice_id: "i" }))
      .resolves.toEqual({ transaction_id: "t", invoice_id: "i" });
  });
});
