import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { aplicarFlujoPue } from "./iva-pue-flujo";
import { padresDeNota, reduccionPorNotaRecibida, totalNetoDeNotas, type PadreDeNota } from "./iva-notas-credito";

// Factura de 11,600 (IVA 1,600) y su nota de 1,160 (IVA 160).
const nota = { total: 1160, ivaNeto: 160 };
const padre = (p: Partial<PadreDeNota> = {}): PadreDeNota => ({
  uuid: "A",
  metodoPago: "PUE",
  total: 11600,
  ivaNoAcreditable: false,
  pagadoAntesDeLaNota: 0,
  ...p,
});

describe("reduccionPorNotaRecibida — Art. 7 LIVA", () => {
  it("sin padre identificable: resta su propio IVA, sin mirar el banco", () => {
    expect(reduccionPorNotaRecibida(nota, [])).toEqual({ reduccion: 160, estado: "SIN_PADRE" });
  });
  it("padre PUE: resta completo (el padre se juzga contra su total neto)", () => {
    expect(reduccionPorNotaRecibida(nota, [padre()])).toEqual({ reduccion: 160, estado: "COMPLETA" });
  });
  it("padre PPD sin pagar: no resta — los REP ya vendrán netos de la nota", () => {
    expect(reduccionPorNotaRecibida(nota, [padre({ metodoPago: "PPD" })])).toEqual({ reduccion: 0, estado: "CUBIERTA_POR_SALDO" });
  });
  it("padre PPD ya pagado completo: resta todo (ese IVA ya se acreditó)", () => {
    expect(reduccionPorNotaRecibida(nota, [padre({ metodoPago: "PPD", pagadoAntesDeLaNota: 11600 })]).reduccion).toBe(160);
  });
  it("padre PPD con saldo menor que la nota: resta sólo el excedente", () => {
    // Saldo 580 de una nota de 1,160: la mitad de la nota ya se había acreditado.
    const r = reduccionPorNotaRecibida(nota, [padre({ metodoPago: "PPD", pagadoAntesDeLaNota: 11020 })]);
    expect(r).toEqual({ reduccion: 80, estado: "PARCIAL" });
  });
  it("padre con IVA excluido por el contador: nada que disminuir", () => {
    expect(reduccionPorNotaRecibida(nota, [padre({ ivaNoAcreditable: true })])).toEqual({ reduccion: 0, estado: "PADRE_NO_ACREDITABLE" });
  });
  it("nota sin IVA (exenta o tasa 0): no resta", () => {
    expect(reduccionPorNotaRecibida({ total: 1000, ivaNeto: 0 }, [])).toEqual({ reduccion: 0, estado: "SIN_IVA" });
  });
  it("nota con retención: resta el neto, como se acreditó el gasto", () => {
    // Honorarios: IVA 160, retenido 106.67 → neto 53.33.
    expect(reduccionPorNotaRecibida({ total: 1053.33, ivaNeto: 53.33 }, []).reduccion).toBe(53.33);
  });
});

describe("totalNetoDeNotas + aplicarFlujoPue: mismo resultado en cualquier orden", () => {
  const ivaPadre = 1600;
  it("el proveedor cobra el neto: el padre acredita completo y la nota resta su IVA", () => {
    const total = totalNetoDeNotas(11600, 1160);
    expect(total).toBe(10440);
    const r = aplicarFlujoPue({ total, ivaNeto: ivaPadre }, { pagadoEnPeriodo: 10440, pagadoAcumulado: 10440 }, "FLUJO");
    expect(r.estado).toBe("PAGADA");
    expect(r.acreditable - reduccionPorNotaRecibida(nota, [padre()]).reduccion).toBe(1440);
  });
  it("pagado completo y bonificación después: 1,600 − 160 = 1,440", () => {
    const r = aplicarFlujoPue({ total: totalNetoDeNotas(11600, 1160), ivaNeto: ivaPadre }, { pagadoEnPeriodo: 11600, pagadoAcumulado: 11600 }, "FLUJO");
    expect(r.acreditable - reduccionPorNotaRecibida(nota, [padre()]).reduccion).toBe(1440);
  });
  it("sin notas el total no cambia", () => {
    expect(totalNetoDeNotas(11600, 0)).toBe(11600);
  });
});

describe("padresDeNota", () => {
  const xml = `<cfdi:Comprobante TipoDeComprobante="E">
    <cfdi:CfdiRelacionados TipoRelacion="01">
      <cfdi:CfdiRelacionado UUID="aaaaaaaa-1111-2222-3333-444444444444"/>
      <cfdi:CfdiRelacionado UUID="bbbbbbbb-1111-2222-3333-444444444444"/>
    </cfdi:CfdiRelacionados>
    <cfdi:CfdiRelacionados TipoRelacion="04">
      <cfdi:CfdiRelacionado UUID="cccccccc-1111-2222-3333-444444444444"/>
    </cfdi:CfdiRelacionados>
    <cfdi:Complemento><tfd:TimbreFiscalDigital UUID="dddddddd-1111-2222-3333-444444444444"/></cfdi:Complemento>
  </cfdi:Comprobante>`;
  it("lee todos los padres 01/03/07 del XML, en mayúsculas, sin la sustitución ni el timbre", () => {
    expect(padresDeNota({ rawXml: xml })).toEqual([
      "AAAAAAAA-1111-2222-3333-444444444444",
      "BBBBBBBB-1111-2222-3333-444444444444",
    ]);
  });
  it("sin XML cae a las columnas del relaciones-backfill", () => {
    expect(padresDeNota({ cfdiRelacionadoUuid: "abc", tipoRelacion: "07" })).toEqual(["ABC"]);
    expect(padresDeNota({ cfdiRelacionadoUuid: "abc", tipoRelacion: "04" })).toEqual([]);
  });
});
