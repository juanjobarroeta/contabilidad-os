import { describe, it, expect } from "vitest";
import {
  construirBriefing,
  empresasConEstadoCuentaVencido,
  construirRecordatorioEstadoCuenta,
  proximoVencimientoMensual,
  type EmpresaBriefing,
} from "./matutino-format";

const emp = (o: Partial<EmpresaBriefing>): EmpresaBriefing => ({
  companyId: "c",
  razonSocial: "Empresa",
  hallazgosAbiertos: 0,
  hallazgosCriticos: 0,
  proxDeadline: null,
  tieneBanco: false,
  diasSinMovimiento: null,
  ...o,
});

describe("construirBriefing", () => {
  it("null cuando no hay nada accionable", () => {
    expect(construirBriefing([emp({})])).toBeNull();
    expect(construirBriefing([])).toBeNull();
  });

  it("prioriza el vencimiento próximo al frente del mensaje", () => {
    const b = construirBriefing([
      emp({ proxDeadline: { periodo: "2026-05", diasRestantes: 4 }, hallazgosAbiertos: 2, hallazgosCriticos: 1 }),
    ])!;
    expect(b.body.startsWith("Quedan 4 días")).toBe(true);
    expect(b.body).toContain("crítico");
    expect(b.url).toBe("/hallazgos"); // una sola empresa
  });

  it("ignora vencimientos fuera de la ventana de aviso", () => {
    const b = construirBriefing([emp({ proxDeadline: { periodo: "2026-05", diasRestantes: 20 } })]);
    expect(b).toBeNull(); // 20 días > ventana y sin hallazgos
  });

  it("modo despacho (multi-empresa) agrega y enlaza a /despacho", () => {
    const b = construirBriefing([
      emp({ companyId: "a", razonSocial: "A", proxDeadline: { periodo: "2026-05", diasRestantes: 2 }, hallazgosAbiertos: 3, hallazgosCriticos: 0 }),
      emp({ companyId: "b", razonSocial: "B", hallazgosAbiertos: 1, hallazgosCriticos: 1 }),
    ])!;
    expect(b.title).toBe("Tu cartera hoy");
    expect(b.url).toBe("/despacho");
    expect(b.body).toContain("2 días");
    expect(b.body).toContain("1 hallazgo crítico");
  });
});

describe("empresasConEstadoCuentaVencido", () => {
  it("incluye empresas con banco y sin movimientos recientes (o nunca)", () => {
    const v = empresasConEstadoCuentaVencido([
      emp({ companyId: "a", tieneBanco: true, diasSinMovimiento: 20 }),
      emp({ companyId: "b", tieneBanco: true, diasSinMovimiento: 2 }), // reciente
      emp({ companyId: "c", tieneBanco: true, diasSinMovimiento: null }), // nunca
      emp({ companyId: "d", tieneBanco: false, diasSinMovimiento: 99 }), // sin banco
    ]);
    expect(v.map((e) => e.companyId).sort()).toEqual(["a", "c"]);
  });
});

describe("construirRecordatorioEstadoCuenta", () => {
  it("null cuando no hay vencidas", () => {
    expect(construirRecordatorioEstadoCuenta([])).toBeNull();
  });
  it("mensaje en singular y plural", () => {
    expect(construirRecordatorioEstadoCuenta([emp({ razonSocial: "ACME" })])!.body).toContain("ACME");
    const multi = construirRecordatorioEstadoCuenta([emp({ razonSocial: "A" }), emp({ razonSocial: "B" })])!;
    expect(multi.body).toContain("2 empresas");
  });
});

describe("proximoVencimientoMensual", () => {
  it("régimen PM (601): hay un vencimiento mensual futuro y razonable", () => {
    // 2026-06-10: la declaración de mayo vence ~17-jun → ~7 días.
    const r = proximoVencimientoMensual("601", new Date(2026, 5, 10));
    expect(r).not.toBeNull();
    expect(r!.diasRestantes).toBeGreaterThanOrEqual(0);
    expect(r!.diasRestantes).toBeLessThan(40);
  });
  it("régimen desconocido → null", () => {
    expect(proximoVencimientoMensual("ZZZ", new Date(2026, 5, 10))).toBeNull();
  });
});
