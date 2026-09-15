import { describe, expect, it } from "vitest";
import { DIAS_DE_PRUEBA, DOCUMENTOS_DE_PRUEBA, decidirSuscripcion, diasHasta, finDePrueba } from "./suscripcion";
import { planDesdeEstadoStripe } from "@/lib/billing/stripe-events";

const ahora = new Date("2026-09-15T12:00:00Z");
const enDias = (d: number) => new Date(ahora.getTime() + d * 24 * 60 * 60 * 1000);

describe("prueba del despacho", () => {
  it("deja trabajar mientras queden días y documentos", () => {
    const e = decidirSuscripcion({ plan: "prueba", pruebaHasta: enDias(10), asientos: 1, periodoFin: null, documentosDelMes: 2 }, ahora);
    expect(e).toMatchObject({ activo: true, avisar: false, diasRestantes: 10, documentosIncluidos: DOCUMENTOS_DE_PRUEBA });
  });

  it("corta por lo que pase primero: días o documentos", () => {
    const porDias = decidirSuscripcion({ plan: "prueba", pruebaHasta: enDias(0), asientos: 1, periodoFin: null, documentosDelMes: 1 }, ahora);
    expect(porDias.activo).toBe(false);
    expect(porDias.motivo).toContain(`${DIAS_DE_PRUEBA} días`);
    const porDocs = decidirSuscripcion({ plan: "prueba", pruebaHasta: enDias(9), asientos: 1, periodoFin: null, documentosDelMes: DOCUMENTOS_DE_PRUEBA }, ahora);
    expect(porDocs.activo).toBe(false);
    expect(porDocs.motivo).toContain("documentos");
    // Siempre se dice que el trabajo sigue ahí: nadie pierde lo que redactó.
    for (const m of [porDias.motivo, porDocs.motivo]) expect(m).toMatch(/intactos|ahí/);
  });

  it("avisa antes de cortar, sin estorbar", () => {
    expect(decidirSuscripcion({ plan: "prueba", pruebaHasta: enDias(3), asientos: 1, periodoFin: null, documentosDelMes: 0 }, ahora).avisar).toBe(true);
    expect(decidirSuscripcion({ plan: "prueba", pruebaHasta: enDias(9), asientos: 1, periodoFin: null, documentosDelMes: DOCUMENTOS_DE_PRUEBA - 1 }, ahora).avisar).toBe(true);
    expect(decidirSuscripcion({ plan: "prueba", pruebaHasta: enDias(9), asientos: 1, periodoFin: null, documentosDelMes: 0 }, ahora).avisar).toBe(false);
  });
});

describe("plan de paga", () => {
  it("pasarse de los documentos incluidos NO corta el servicio, sólo avisa", () => {
    const e = decidirSuscripcion({ plan: "activo", pruebaHasta: null, asientos: 2, periodoFin: enDias(12), documentosDelMes: 999 }, ahora);
    expect(e.activo).toBe(true);
    expect(e.avisar).toBe(true);
    // Los incluidos escalan con los asientos.
    expect(e.documentosIncluidos).toBe(20);
  });

  it("suspendido y cancelado cortan, diciendo qué hacer y que nada se perdió", () => {
    const s = decidirSuscripcion({ plan: "suspendido", pruebaHasta: null, asientos: 1, periodoFin: null, documentosDelMes: 0 }, ahora);
    expect(s.activo).toBe(false);
    expect(s.motivo).toMatch(/tarjeta/);
    expect(s.motivo).toMatch(/intactos/);
    const c = decidirSuscripcion({ plan: "cancelado", pruebaHasta: null, asientos: 1, periodoFin: null, documentosDelMes: 0 }, ahora);
    expect(c.activo).toBe(false);
    expect(c.motivo).toMatch(/cancelada/);
  });
});

describe("estados de Stripe", () => {
  it("past_due todavía deja trabajar: Stripe sigue reintentando el cobro", () => {
    expect(planDesdeEstadoStripe("active")).toBe("activo");
    expect(planDesdeEstadoStripe("trialing")).toBe("activo");
    expect(planDesdeEstadoStripe("past_due")).toBe("activo");
    expect(planDesdeEstadoStripe("canceled")).toBe("cancelado");
    expect(planDesdeEstadoStripe("incomplete_expired")).toBe("cancelado");
    expect(planDesdeEstadoStripe("unpaid")).toBe("suspendido");
  });
});

describe("fechas", () => {
  it("la prueba dura los días que dice, y diasHasta no da negativos", () => {
    expect(diasHasta(finDePrueba(ahora), ahora)).toBe(DIAS_DE_PRUEBA);
    expect(diasHasta(enDias(-5), ahora)).toBe(0);
    expect(diasHasta(null)).toBeNull();
  });
});
