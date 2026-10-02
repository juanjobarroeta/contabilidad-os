import { describe, expect, it } from "vitest";
import { capabilityCatalogue, managedTools, validateToolInput } from "./capabilities";

describe("ContaBot capabilities", () => {
  it("gives a viewer reads and presentation, never writes or the operator connector", () => {
    const names = managedTools(false).flatMap((t) => t.type === "function" ? [t.name] : []);
    expect(names).toContain("query_bank_transactions");
    expect(names).toContain("query_iva_cobro");
    expect(names).not.toContain("proponer_revision_iva_cobro");
    expect(capabilityCatalogue(true).capabilities.find((c) => c.name === "proponer_revision_iva_cobro"))
      .toMatchObject({ execution: "requires_user_confirmation" });
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

  it("accepts documented PUE proposals but never model-selected company scope", async () => {
    const proposal = {
      invoice_id: "i", expected: "a".repeat(64), tratamiento: "FLUJO_GENERAL",
      fecha_cobro: "2026-09-30", evidencia: "Receipt reference 42",
      motivo: "Documented collection and ordinary cash IVA reviewed",
    };
    await expect(validateToolInput("proponer_revision_iva_cobro", proposal)).resolves.toEqual(proposal);
    await expect(validateToolInput("proponer_revision_iva_cobro", { ...proposal, companyId: "other" }))
      .rejects.toThrow("INVALID_ARGUMENTS");
    await expect(validateToolInput("proponer_revision_iva_cobro", { ...proposal, tratamiento: "AUTO_APPROVED" }))
      .rejects.toThrow("INVALID_ARGUMENTS");
    await expect(validateToolInput("query_iva_cobro", { invoice_id: "i", cursor: -1 }))
      .rejects.toThrow("INVALID_ARGUMENTS");
  });
});
