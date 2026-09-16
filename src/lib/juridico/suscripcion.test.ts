import { describe, expect, it } from "vitest";
import { DIAS_DE_PRUEBA, DOCUMENTOS_DE_PRUEBA, TOPE_USD_PRUEBA, decidirSuscripcion, diasHasta, finDePrueba } from "./suscripcion";
import { planDesdeEstadoStripe } from "@/lib/billing/stripe-events";

const ahora = new Date("2026-09-15T12:00:00Z");
const enDias = (d: number) => new Date(ahora.getTime() + d * 24 * 60 * 60 * 1000);

describe("prueba del despacho", () => {
  it("deja trabajar mientras queden días y documentos", () => {
    const e = decidirSuscripcion({ plan: "prueba", pruebaHasta: enDias(5), asientos: 1, periodoFin: null, documentosDelMes: 2 }, ahora);
    expect(e).toMatchObject({ activo: true, avisar: false, diasRestantes: 5, documentosIncluidos: DOCUMENTOS_DE_PRUEBA });
  });

  it("corta por lo que pase primero: días o documentos", () => {
    const porDias = decidirSuscripcion({ plan: "prueba", pruebaHasta: enDias(0), asientos: 1, periodoFin: null, documentosDelMes: 1 }, ahora);
    expect(porDias.activo).toBe(false);
    expect(porDias.motivo).toContain(`${DIAS_DE_PRUEBA} días`);
    const porDocs = decidirSuscripcion({ plan: "prueba", pruebaHasta: enDias(5), asientos: 1, periodoFin: null, documentosDelMes: DOCUMENTOS_DE_PRUEBA }, ahora);
    expect(porDocs.activo).toBe(false);
    expect(porDocs.motivo).toContain("documentos");
    // Siempre se dice que el trabajo sigue ahí: nadie pierde lo que redactó.
    for (const m of [porDias.motivo, porDocs.motivo]) expect(m).toMatch(/intactos|ahí|como están/);
  });

  it("avisa antes de cortar, sin estorbar", () => {
    // Con una prueba de siete días, avisar a los tres sería avisar casi la
    // mitad del tiempo: el umbral es de dos días.
    expect(decidirSuscripcion({ plan: "prueba", pruebaHasta: enDias(2), asientos: 1, periodoFin: null, documentosDelMes: 0 }, ahora).avisar).toBe(true);
    expect(decidirSuscripcion({ plan: "prueba", pruebaHasta: enDias(3), asientos: 1, periodoFin: null, documentosDelMes: 0 }, ahora).avisar).toBe(false);
    expect(decidirSuscripcion({ plan: "prueba", pruebaHasta: enDias(5), asientos: 1, periodoFin: null, documentosDelMes: DOCUMENTOS_DE_PRUEBA - 1 }, ahora).avisar).toBe(true);
    expect(decidirSuscripcion({ plan: "prueba", pruebaHasta: enDias(5), asientos: 1, periodoFin: null, documentosDelMes: 0 }, ahora).avisar).toBe(false);
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

// El tercer corte. Sin él, una semana de consultas sin freno cuesta más que el
// primer mes de suscripción: la prueba dejaría de ser una inversión.
describe("el tope de gasto de la prueba", () => {
  const enPrueba = (gastoUsd: number, documentosDelMes = 0) =>
    decidirSuscripcion({ plan: "prueba", pruebaHasta: enDias(5), asientos: 1, periodoFin: null, documentosDelMes, gastoUsd }, ahora);

  it("deja trabajar mientras no se pase", () => {
    const e = enPrueba(4.5);
    expect(e.activo).toBe(true);
    expect(e).toMatchObject({ gastoUsd: 4.5, topeUsd: TOPE_USD_PRUEBA });
  });

  it("corta al llegar al tope, aunque queden días y documentos", () => {
    const e = enPrueba(TOPE_USD_PRUEBA);
    expect(e.activo).toBe(false);
    expect(e.diasRestantes).toBe(5);
    expect(e.documentosUsados).toBe(0);
    // Nadie pierde su trabajo, y se dice.
    expect(e.motivo).toMatch(/casos|borradores/);
  });

  it("avisa antes de cortar, al 80 % del tope", () => {
    expect(enPrueba(TOPE_USD_PRUEBA * 0.79).avisar).toBe(false);
    expect(enPrueba(TOPE_USD_PRUEBA * 0.8).avisar).toBe(true);
  });

  it("no le pone tope de gasto a quien ya paga", () => {
    const e = decidirSuscripcion({ plan: "activo", pruebaHasta: null, asientos: 2, periodoFin: enDias(20), documentosDelMes: 3, gastoUsd: 500 }, ahora);
    expect(e.activo).toBe(true);
    expect(e.gastoUsd).toBeUndefined();
    expect(e.topeUsd).toBeUndefined();
  });

  it("la prueba dura siete días", () => {
    expect(DIAS_DE_PRUEBA).toBe(7);
    const vencida = decidirSuscripcion({ plan: "prueba", pruebaHasta: enDias(0), asientos: 1, periodoFin: null, documentosDelMes: 0, gastoUsd: 0 }, ahora);
    expect(vencida.activo).toBe(false);
    expect(vencida.motivo).toContain("7 días");
  });
});

// El 16-sep-2026 el tope de 20 USD dejó al operador fuera de su propio
// producto: su despacho llevaba 49.98 USD de uso real. El tope es para los
// prospectos, no para nuestra propia casa.
describe("el despacho del operador no se corta por gasto", () => {
  const conOperador = (gastoUsd: number) =>
    decidirSuscripcion({ plan: "prueba", pruebaHasta: enDias(5), asientos: 1, periodoFin: null, documentosDelMes: 0, gastoUsd, sinTopeDeGasto: true }, ahora);

  it("sigue trabajando muy por encima del tope", () => {
    const e = conOperador(TOPE_USD_PRUEBA * 5);
    expect(e.activo).toBe(true);
    expect(e.avisar).toBe(false);
  });

  it("aun así reporta el gasto real, sin maquillarlo", () => {
    expect(conOperador(49.98).gastoUsd).toBe(49.98);
  });

  it("los días y los documentos sí lo siguen cortando", () => {
    const porDias = decidirSuscripcion({ plan: "prueba", pruebaHasta: enDias(0), asientos: 1, periodoFin: null, documentosDelMes: 0, gastoUsd: 999, sinTopeDeGasto: true }, ahora);
    expect(porDias.activo).toBe(false);
    const porDocs = decidirSuscripcion({ plan: "prueba", pruebaHasta: enDias(5), asientos: 1, periodoFin: null, documentosDelMes: DOCUMENTOS_DE_PRUEBA, gastoUsd: 999, sinTopeDeGasto: true }, ahora);
    expect(porDocs.activo).toBe(false);
  });

  it("a un despacho normal el tope sí lo corta", () => {
    expect(decidirSuscripcion({ plan: "prueba", pruebaHasta: enDias(5), asientos: 1, periodoFin: null, documentosDelMes: 0, gastoUsd: TOPE_USD_PRUEBA }, ahora).activo).toBe(false);
  });
});
