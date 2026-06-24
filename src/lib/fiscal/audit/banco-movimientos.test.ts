import { describe, it, expect } from "vitest";
import { auditarBancoDesactualizado, type CuentaDesactualizada } from "./banco-movimientos";

describe("auditarBancoDesactualizado", () => {
  it("emite un hallazgo por cuenta atrasada con días y última fecha", () => {
    const items: CuentaDesactualizada[] = [
      { accountId: "acc1", etiqueta: "BBVA Principal ••1234", ultimaFecha: "2026-06-01", dias: 23 },
    ];
    const h = auditarBancoDesactualizado(items);
    expect(h).toHaveLength(1);
    expect(h[0].checkClave).toBe("banco.movimientos_desactualizados");
    expect(h[0].severidad).toBe("warn");
    expect(h[0].referencias).toEqual(["acc1"]);
    expect(h[0].mensaje).toContain("23 días");
    expect(h[0].mensaje).toContain("2026-06-01");
    expect(h[0].mensaje).toContain("••1234");
  });

  it("sin cuentas atrasadas no emite hallazgos", () => {
    expect(auditarBancoDesactualizado([])).toHaveLength(0);
  });
});
