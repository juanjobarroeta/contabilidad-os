import { describe, it, expect } from "vitest";
import { estadoDelPeriodo } from "./estado-periodo";
import { avanceDelCierre } from "./acciones";
import type { CierreEvaluado, PasoConDecision } from "./evaluar";

function paso(over: Partial<PasoConDecision>): PasoConDecision {
  return {
    clave: "declaracion",
    titulo: "Declaración",
    descripcion: "",
    orden: 10,
    estadoCalculado: "atencion",
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
    companyId: "c1", year: 2021, month: 7, periodo: "2021-07",
    cierreId: null, responsableUserId: null, conversationId: null, cerradoAt: null,
    pasos,
    resumen: { total: pasos.length, aplican: pasos.length, listos: 0, atencion: 0, bloquean: 0, confirmados: 0, completo: false },
  };
}

const PRESENTADA = { clave: "fx:declaracion-periodo", estado: "ok" as const, resumen: "La declaración del periodo ya está presentada." };

describe("estadoDelPeriodo — un mes ya declarado no es trabajo pendiente", () => {
  it("lo da por declarado cuando la señal de la declaración está en ok", () => {
    const e = estadoDelPeriodo(cierre([paso({ senales: [PRESENTADA] })]));
    expect(e.declarado).toBe(true);
    expect(e.detalle).toContain("presentada");
  });

  it("no lo da por declarado si la señal pide atención", () => {
    const e = estadoDelPeriodo(
      cierre([paso({ senales: [{ clave: "fx:declaracion-periodo", estado: "warn", resumen: "falta presentarla" }] })])
    );
    expect(e.declarado).toBe(false);
  });

  it("no lo da por declarado cuando el paso no aplica", () => {
    const e = estadoDelPeriodo(cierre([paso({ estadoCalculado: "no_aplica", senales: [PRESENTADA] })]));
    expect(e.declarado).toBe(false);
  });

  it("marca el pago sólo cuando su señal lo dice", () => {
    const sinPago = estadoDelPeriodo(cierre([paso({ senales: [PRESENTADA] })]));
    expect(sinPago.pagado).toBe(false);
    const conPago = estadoDelPeriodo(
      cierre([paso({ senales: [PRESENTADA, { clave: "x:pago_conciliado", estado: "ok", resumen: "pago ligado" }] })])
    );
    expect(conPago.pagado).toBe(true);
  });

  it("el avance de un mes declarado cuenta completo, sin pedir confirmar doce pasos", () => {
    const c = cierre([
      paso({ senales: [PRESENTADA] }),
      paso({ clave: "banco", orden: 4, estadoCalculado: "atencion", senales: [{ clave: "x:firmas_conciliacion", estado: "warn", resumen: "0 de 1" }] }),
    ]);
    expect(avanceDelCierre(c)).toEqual({ listos: 2, total: 2 });
  });

  it("sin declarar, el avance sí cuenta sólo lo listo", () => {
    const c = cierre([
      paso({ senales: [{ clave: "fx:declaracion-periodo", estado: "warn", resumen: "falta" }] }),
      paso({ clave: "banco", orden: 4, estadoCalculado: "listo" }),
    ]);
    expect(avanceDelCierre(c)).toEqual({ listos: 1, total: 2 });
  });
});
