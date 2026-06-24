import { describe, it, expect } from "vitest";
import { extractoresADisparar, EXTRACTORES_PROVISION } from "./cadencia";

const ahora = new Date("2026-06-24T12:00:00Z");
const hace = (dias: number) => new Date(ahora.getTime() - dias * 24 * 60 * 60 * 1000);

describe("extractoresADisparar", () => {
  it("ASISTENTE no dispara nada (sin Syntage en el plan)", () => {
    expect(extractoresADisparar({ plan: "ASISTENTE", ultimaPorExtractor: {}, ahora })).toEqual([]);
  });

  it("force dispara las 4, aun en ASISTENTE (onboarding manual)", () => {
    const r = extractoresADisparar({ plan: "ASISTENTE", ultimaPorExtractor: {}, ahora, force: true });
    expect(r).toEqual([...EXTRACTORES_PROVISION]);
  });

  it("empresa nueva sin historial dispara las 4", () => {
    const r = extractoresADisparar({ plan: "AUTOMATIZADO", ultimaPorExtractor: {}, ahora });
    expect(r.sort()).toEqual([...EXTRACTORES_PROVISION].sort());
  });

  it("respeta la cadencia: nada vencido → no dispara", () => {
    const r = extractoresADisparar({
      plan: "AUTOMATIZADO",
      ultimaPorExtractor: {
        tax_compliance: hace(1), // semanal, fresco
        tax_status: hace(5), // mensual, fresco
        monthly_tax_return: hace(5), // mensual, fresco
        annual_tax_return: hace(5), // trimestral, fresco
      },
      ahora,
    });
    expect(r).toEqual([]);
  });

  it("dispara sólo los vencidos (opinión semanal vencida, CSF mensual no)", () => {
    const r = extractoresADisparar({
      plan: "PRO",
      ultimaPorExtractor: {
        tax_compliance: hace(8), // > 7 → vencido
        tax_status: hace(10), // < 30 → no
        monthly_tax_return: hace(40), // > 30 → vencido
        annual_tax_return: hace(40), // < 90 → no
      },
      ahora,
    });
    expect(r.sort()).toEqual(["monthly_tax_return", "tax_compliance"]);
  });
});
