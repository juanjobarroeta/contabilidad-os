import { describe, it, expect } from "vitest";
import { montoDeObligacion, totalVencido } from "./obligaciones-monto";

describe("montoDeObligacion", () => {
  it("sin declaración no inventa un cero", () => {
    // Cero pesos y "no lo hemos calculado" son cosas distintas.
    expect(montoDeObligacion("IVA_MENSUAL", null)).toEqual({ monto: null, motivo: "sin_calcular", estimado: false });
  });

  it("presentada = hecho: el monto NO va marcado como estimado", () => {
    expect(montoDeObligacion("IVA_MENSUAL", { status: "FILED", ivaPagar: 5376.01 }))
      .toEqual({ monto: 5376.01, motivo: null, estimado: false });
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

  it("las informativas no llevan importe, y dicen que es POR ESO", () => {
    // Pintar "$0.00 por pagar" en una DIOT sería falso; decir "sin calcular"
    // sería acusarnos de un trabajo pendiente que no existe. Caso real visto
    // en producción (BAOBAB JQM): la única vencida era una DIOT.
    const d = { status: "FILED", ivaPagar: 999 };
    expect(montoDeObligacion("DIOT", d)).toEqual({ monto: null, motivo: "informativa", estimado: false });
    expect(montoDeObligacion("CERO", d).motivo).toBe("informativa");
  });

  it("sin cifra por falta de cálculo NO se confunde con informativa", () => {
    expect(montoDeObligacion("IVA_MENSUAL", null).motivo).toBe("sin_calcular");
    expect(montoDeObligacion("IVA_MENSUAL", { status: "DRAFT", ivaPagar: null }).motivo).toBe("sin_calcular");
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
  const ob = (p: Partial<{ status: string; filed: boolean; monto: number | null; montoEstimado: boolean; montoMotivo: "informativa" | "sin_calcular" | null }>) => ({
    status: "OVERDUE", filed: false, monto: 100, montoEstimado: false, montoMotivo: null, ...p,
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

  it("las informativas se cuentan aparte de lo que falta calcular", () => {
    // Si TODO lo vencido es informativa, el tablero no debe encabezar con
    // "lo que debes": no se debe dinero, se debe una presentación.
    const r = totalVencido([
      ob({ monto: null, montoMotivo: "informativa" }),
      ob({ monto: null, montoMotivo: "sin_calcular" }),
    ]);
    expect(r.informativas).toBe(1);
    expect(r.sinMonto).toBe(1);
    expect(r.total).toBe(0);
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
    expect(r).toEqual({ total: 0, conMonto: 0, sinMonto: 0, informativas: 0, algunoEstimado: false });
  });
});
