import { describe, it, expect } from "vitest";
import {
  debeArrancarCE,
  extractoresADisparar,
  EXTRACTORES_PROVISION,
  EXTRACTORES_TRIAL,
} from "./cadencia";

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

  it("TRIAL sólo extrae la probadita (opinión + CSF), sin backfill de declaraciones", () => {
    const r = extractoresADisparar({
      plan: "AUTOMATIZADO",
      ultimaPorExtractor: {},
      ahora,
      nivelPago: "TRIAL",
    });
    expect(r.sort()).toEqual([...EXTRACTORES_TRIAL].sort());
  });

  it("TRIAL acota INCLUSO con force (la subida de e.firma auto-dispara force)", () => {
    const r = extractoresADisparar({
      plan: "PRO",
      ultimaPorExtractor: {},
      ahora,
      force: true,
      nivelPago: "TRIAL",
    });
    expect(r.sort()).toEqual([...EXTRACTORES_TRIAL].sort());
  });

  it("al convertir a ACTIVO la cadencia detecta lo que falta y lo extrae", () => {
    // Durante el trial sólo se extrajo la probadita; ya con pago, los
    // extractores nunca disparados (anual/mensual) salen de inmediato.
    const r = extractoresADisparar({
      plan: "AUTOMATIZADO",
      ultimaPorExtractor: { tax_compliance: hace(1), tax_status: hace(1) },
      ahora,
      nivelPago: "ACTIVO",
    });
    expect(r.sort()).toEqual(["annual_tax_return", "monthly_tax_return"]);
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

  it("re-dispara dato faltante aunque la cadencia diga fresco (pasado el piso)", () => {
    const r = extractoresADisparar({
      plan: "AUTOMATIZADO",
      ultimaPorExtractor: {
        tax_compliance: hace(1), // fresco por cadencia (7d)
        tax_status: hace(5), // fresco por cadencia (30d)
        monthly_tax_return: hace(5),
        annual_tax_return: hace(5),
      },
      datosPresentes: {
        tax_compliance: true,
        tax_status: false, // CSF nunca aterrizó → reintentar
        monthly_tax_return: true,
        annual_tax_return: true,
      },
      ahora,
    });
    expect(r).toEqual(["tax_status"]);
  });

  it("dato faltante PERO disparado hace < piso → espera (no martillar)", () => {
    const r = extractoresADisparar({
      plan: "AUTOMATIZADO",
      ultimaPorExtractor: {
        tax_compliance: hace(1),
        tax_status: hace(1), // < 3 (piso de reintento)
        monthly_tax_return: hace(1),
        annual_tax_return: hace(1),
      },
      datosPresentes: { tax_status: false },
      ahora,
    });
    expect(r).toEqual([]);
  });

  it("sin datosPresentes se comporta como antes (sólo cadencia)", () => {
    const r = extractoresADisparar({
      plan: "AUTOMATIZADO",
      ultimaPorExtractor: {
        tax_compliance: hace(1), // fresco
        tax_status: hace(40), // vencido por cadencia (30d)
        monthly_tax_return: hace(1), // fresco
        annual_tax_return: hace(1), // fresco
      },
      ahora,
    });
    expect(r).toEqual(["tax_status"]);
  });
});

describe("debeArrancarCE — piso de reintento del bootstrap de Contabilidad Electrónica", () => {
  const base = { plan: "AUTOMATIZADO" as const, ceBootstrapAt: null, ahora };

  it("nunca intentada → dispara", () => {
    expect(debeArrancarCE({ ...base, ultimoIntentoCE: null })).toBe(true);
  });

  it("TRIAL nunca arranca la CE, ni con force (parte del backfill caro)", () => {
    expect(debeArrancarCE({ ...base, ultimoIntentoCE: null, nivelPago: "TRIAL" })).toBe(false);
    expect(
      debeArrancarCE({ ...base, ultimoIntentoCE: null, nivelPago: "TRIAL", force: true })
    ).toBe(false);
  });

  it("ya bootstrapeada → nunca re-dispara (ni con force)", () => {
    expect(debeArrancarCE({ ...base, ceBootstrapAt: hace(100), ultimoIntentoCE: null })).toBe(false);
    expect(
      debeArrancarCE({ ...base, ceBootstrapAt: hace(100), ultimoIntentoCE: null, force: true })
    ).toBe(false);
  });

  it("intento reciente sin aterrizar → respeta el piso de 30 días (el bug: re-disparaba a diario)", () => {
    expect(debeArrancarCE({ ...base, ultimoIntentoCE: hace(1) })).toBe(false);
    expect(debeArrancarCE({ ...base, ultimoIntentoCE: hace(29) })).toBe(false);
    expect(debeArrancarCE({ ...base, ultimoIntentoCE: hace(30) })).toBe(true);
    expect(debeArrancarCE({ ...base, ultimoIntentoCE: hace(45) })).toBe(true);
  });

  it("force brinca el piso pero no el ceBootstrapAt", () => {
    expect(debeArrancarCE({ ...base, ultimoIntentoCE: hace(1), force: true })).toBe(true);
  });

  it("ASISTENTE no arranca CE (salvo force)", () => {
    expect(debeArrancarCE({ ...base, plan: "ASISTENTE", ultimoIntentoCE: null })).toBe(false);
    expect(debeArrancarCE({ ...base, plan: "ASISTENTE", ultimoIntentoCE: null, force: true })).toBe(true);
  });
});
