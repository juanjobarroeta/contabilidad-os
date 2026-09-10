import { describe, it, expect } from "vitest";
import { resumenNegocio } from "./negocio";
import { resolverEstadoCierre, type EstadoContableCierre } from "./estado-canonico";
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

function cierre(
  pasos: PasoConDecision[],
  accountingStatus: EstadoContableCierre | null = "DRAFT",
  declaracionExterna = false
): CierreEvaluado {
  return {
    companyId: "c1",
    year: 2026,
    month: 8,
    periodo: "2026-08",
    cierreId: "x",
    responsableUserId: null,
    conversationId: null,
    cerradoAt: null,
    accountingStatus,
    estado: resolverEstadoCierre({ estadoContable: accountingStatus, pasos, declaracionExterna }),
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

  it("no dice al corriente si la declaración existe pero apareció un bloqueo", () => {
    const r = resumenNegocio(
      cierre([
        paso({
          clave: "declaracion",
          estadoCalculado: "listo",
          senales: [{ clave: "fx:declaracion-periodo", estado: "ok", resumen: "Presentada" }],
        }),
        paso({
          estadoCalculado: "bloquea",
          detalle: "Sin estado de cuenta",
          senales: [{ clave: "x:cuentas_sin_estado", estado: "error", resumen: "Sin estado de cuenta" }],
        }),
      ], "CLOSED")
    );
    expect(r.declarado).toBe(true);
    expect(r.alDia).toBe(false);
    expect(r.detienen).toBe(1);
  });

  it("no inventa que ya se declaró cuando el paso no tiene señales", () => {
    const r = resumenNegocio(cierre([paso({ clave: "declaracion", senales: [] })]));
    expect(r.declarado).toBe(false);
  });

  it("presenta un cierre histórico externo como al corriente sin trasladar su reconstrucción al dueño", () => {
    const r = resumenNegocio(
      cierre([
        paso({ clave: "declaracion", estadoCalculado: "sin_datos", senales: [] }),
        paso({ estadoCalculado: "bloquea", detalle: "Sin estado de cuenta" }),
      ], null, true)
    );
    expect(r).toMatchObject({
      alDia: true,
      declarado: true,
      cerradoFueraDeContabilidadOS: true,
      detienen: 0,
      falta: [],
    });
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

  it("falla cerrado si recibe una espera sin el bloqueo que la originó", () => {
    const r = resumenNegocio(
      cierre([
        paso({
          estadoCalculado: "espera",
          senales: [{ clave: "x:firmas_conciliacion", estado: "warn", resumen: "0 de 1" }],
        }),
      ])
    );
    expect(r.alDia).toBe(false);
    expect(r.detienen).toBe(1);
  });
});
