import { describe, it, expect } from "vitest";
import { resumenNegocio } from "./negocio";
import type { CierreEvaluado, PasoConDecision } from "./evaluar";

function paso(over: Partial<PasoConDecision>): PasoConDecision {
  return {
    clave: "banco",
    titulo: "Bancos",
    descripcion: "",
    orden: 4,
    estadoCalculado: "listo",
    detalle: null,
    senales: [],
    cifras: {},
    hechos: {},
    hashEvidencia: "h",
    cta: { label: "", href: "" },
    requiereConfirmacion: true,
    estado: "PENDIENTE",
    confirmadoAt: null,
    confirmadoByUserId: null,
    nota: null,
    ...over,
  } as PasoConDecision;
}

function cierre(pasos: PasoConDecision[]): CierreEvaluado {
  return {
    companyId: "c1",
    year: 2026,
    month: 8,
    periodo: "2026-08",
    cierreId: "x",
    responsableUserId: null,
    conversationId: null,
    cerradoAt: null,
    pasos,
    resumen: { total: pasos.length, aplican: pasos.length, listos: 0, atencion: 0, bloquean: 0, confirmados: 0, completo: false },
  };
}

describe("resumenNegocio — el mes contado al dueño", () => {
  it("dice al corriente cuando no queda nada por hacer", () => {
    const r = resumenNegocio(cierre([paso({ estadoCalculado: "listo" })]));
    expect(r.alDia).toBe(true);
    expect(r.falta).toEqual([]);
  });

  it("traduce los pendientes a lenguaje llano y marca los que detienen", () => {
    const r = resumenNegocio(
      cierre([
        paso({
          estadoCalculado: "bloquea",
          senales: [{ clave: "x:firmas_conciliacion", estado: "error", resumen: "0 de 1 cuenta firmada" }],
        }),
      ])
    );
    expect(r.alDia).toBe(false);
    expect(r.falta[0].hacer).toBe("Dar por conciliada la cuenta del banco");
    expect(r.falta[0].detiene).toBe(true);
    expect(r.detienen).toBe(1);
  });

  it("no inventa que ya se declaró cuando el paso no tiene señales", () => {
    const r = resumenNegocio(cierre([paso({ clave: "declaracion", senales: [] })]));
    expect(r.declarado).toBe(false);
  });

  it("toma las cifras del paso de declaración tal cual, sin recalcular", () => {
    const r = resumenNegocio(
      cierre([paso({ clave: "declaracion", cifras: { ivaPagar: 1234.5, isrPagar: 900, fechaLimite: "2026-09-17" }, fechaLimite: "2026-09-17", diasRestantes: 10 })])
    );
    expect(r.aPagar).toEqual({ iva: 1234.5, isr: 900 });
    expect(r.diasRestantes).toBe(10);
  });

  it("sin cifras calculadas no inventa un cero", () => {
    const r = resumenNegocio(cierre([paso({ clave: "declaracion", cifras: {} })]));
    expect(r.aPagar).toBeNull();
  });

  it("no cuenta como pendiente un paso que espera a otro", () => {
    const r = resumenNegocio(
      cierre([
        paso({
          estadoCalculado: "espera",
          senales: [{ clave: "x:firmas_conciliacion", estado: "warn", resumen: "0 de 1" }],
        }),
      ])
    );
    expect(r.alDia).toBe(true);
  });
});
