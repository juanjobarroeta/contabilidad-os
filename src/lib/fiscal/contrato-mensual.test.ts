import { describe, expect, it } from "vitest";
import { contratoMensualFiscal } from "./contrato-mensual";

describe("contratoMensualFiscal", () => {
  it("is the parity contract for the September 2026 monthly APIs", () => {
    const contract = contratoMensualFiscal(new Date("2026-09-09T18:00:00Z"));

    expect(contract).toEqual({
      hoy: { year: 2026, month: 9, day: 9, key: "2026-09-09" },
      periodo: { year: 2026, month: 8, key: "2026-08" },
      fechaLimite: "2026-09-17",
      diasRestantes: 8,
      vencida: false,
    });
    expect(contract.fechaLimite).not.toContain("T");
  });

  it("does not advance at Railway midnight while Mexico is still in August", () => {
    const contract = contratoMensualFiscal(new Date("2026-09-01T00:30:00Z"));

    expect(contract.hoy.key).toBe("2026-08-31");
    expect(contract.periodo.key).toBe("2026-07");
    expect(contract.fechaLimite).toBe("2026-08-17");
    expect(contract.vencida).toBe(true);
  });

  it("crosses the annual boundary without emitting a timestamp", () => {
    const contract = contratoMensualFiscal(new Date("2027-01-04T18:00:00Z"));

    expect(contract.periodo.key).toBe("2026-12");
    expect(contract.fechaLimite).toBe("2027-01-18");
  });
});
