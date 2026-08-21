import { describe, it, expect } from "vitest";
import { montoDeObligacion, totalVencido } from "./obligaciones-monto";

describe("montoDeObligacion", () => {
  it("sin declaración no inventa un cero", () => {
    // Cero pesos y "no lo hemos calculado" son cosas distintas.
    expect(montoDeObligacion("IVA_MENSUAL", null)).toEqual({ monto: null, estimado: false });
  });

  it("presentada = hecho: el monto NO va marcado como estimado", () => {
    expect(montoDeObligacion("IVA_MENSUAL", { status: "FILED", ivaPagar: 5376.01 }))
      .toEqual({ monto: 5376.01, estimado: false });
    expect(montoDeObligacion("IVA_MENSUAL", { status: "PAID", ivaPagar: 5376.01 }).estimado)
      .toBe(false);
  });

  it("borrador o calculada = cuenta NUESTRA: va marcada estimado", () => {
    // Es la distinción que sostiene la confianza: si no se presentó, la cifra
    // es lo que dedujimos de los CFDIs y puede moverse.
    expect(montoDeObligacion("IVA_MENSUAL", { status: "DRAFT", ivaPagar: 100 }).estimado).toBe(true);
    expect(montoDeObligacion("IVA_MENSUAL", { status: "CALCULATED", ivaPagar: 100 }).estimado).toBe(true);
  });

  it("cada tipo lee SU campo", () => {
    const d = {
      status: "FILED",
      ivaPagar: 1, isrPagar: 2, retencionesIsr: 3, iepsPagar: 4, imssCuotas: 5,
    };
    expect(montoDeObligacion("IVA_MENSUAL", d).monto).toBe(1);
    expect(montoDeObligacion("ISR_PROVISIONAL", d).monto).toBe(2);
    expect(montoDeObligacion("DECLARACION_ANUAL", d).monto).toBe(2);
    expect(montoDeObligacion("RETENCIONES_ISR", d).monto).toBe(3);
    expect(montoDeObligacion("IEPS_MENSUAL", d).monto).toBe(4);
    expect(montoDeObligacion("IMSS", d).monto).toBe(5);
  });

  it("las informativas no llevan importe", () => {
    // Pintar "$0.00 por pagar" en una DIOT sería decir algo falso.
    const d = { status: "FILED", ivaPagar: 999 };
    expect(montoDeObligacion("DIOT", d).monto).toBeNull();
    expect(montoDeObligacion("CERO", d).monto).toBeNull();
  });

  it("un campo nulo o no finito es 'no sabemos', no cero", () => {
    expect(montoDeObligacion("IVA_MENSUAL", { status: "FILED", ivaPagar: null }).monto).toBeNull();
    expect(montoDeObligacion("IVA_MENSUAL", { status: "FILED", ivaPagar: NaN }).monto).toBeNull();
  });

  it("un tipo desconocido no revienta ni adivina", () => {
    expect(montoDeObligacion("LO_QUE_SEA", { status: "FILED", ivaPagar: 9 }).monto).toBeNull();
  });
});

describe("totalVencido", () => {
  const ob = (p: Partial<{ status: string; filed: boolean; monto: number | null; montoEstimado: boolean }>) => ({
    status: "OVERDUE", filed: false, monto: 100, montoEstimado: false, ...p,
  });

  it("sólo suma lo vencido y NO presentado", () => {
    const r = totalVencido([
      ob({ monto: 100 }),
      ob({ monto: 50, filed: true }),      // ya presentada
      ob({ monto: 25, status: "SOON" }),   // aún no vence
    ]);
    expect(r.total).toBe(100);
    expect(r.conMonto).toBe(1);
  });

  it("lo que no tiene monto se reporta aparte, no se cuenta como cero", () => {
    // Un total que esconde obligaciones sin cifra miente por omisión.
    const r = totalVencido([ob({ monto: 100 }), ob({ monto: null }), ob({ monto: null })]);
    expect(r.total).toBe(100);
    expect(r.sinMonto).toBe(2);
  });

  it("basta UNA estimada para que el total sea aproximado", () => {
    expect(totalVencido([ob({ monto: 1 }), ob({ monto: 2, montoEstimado: true })]).algunoEstimado).toBe(true);
    expect(totalVencido([ob({ monto: 1 }), ob({ monto: 2 })]).algunoEstimado).toBe(false);
  });

  it("sin vencidas, total en cero y nada estimado", () => {
    const r = totalVencido([ob({ status: "UPCOMING" })]);
    expect(r).toEqual({ total: 0, conMonto: 0, sinMonto: 0, algunoEstimado: false });
  });
});
