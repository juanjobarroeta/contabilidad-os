import { describe, it, expect } from "vitest";
import { sugerirPagoJunto, type FacturaParaPagoJunto } from "./pago-junto";

const f = (id: string, saldo: number, rfc = "AAA010101AA1"): FacturaParaPagoJunto => ({ id, rfc, saldo });

describe("sugerirPagoJunto — un SPEI que salda varias facturas de la misma contraparte", () => {
  it("encuentra el subconjunto exacto de una contraparte", () => {
    const r = sugerirPagoJunto(3480.5, [f("a", 1160), f("b", 2320.5), f("c", 999)]);
    expect(r).not.toBeNull();
    expect(r!.asignaciones.map((a) => a.invoiceId).sort()).toEqual(["a", "b"]);
    expect(r!.asignaciones.reduce((s, a) => s + a.monto, 0)).toBeCloseTo(3480.5, 2);
  });

  it("exactitud al centavo: a un centavo de distancia no hay sugerencia", () => {
    expect(sugerirPagoJunto(3480.51, [f("a", 1160), f("b", 2320.5)])).toBeNull();
  });

  it("no combina facturas de contrapartes distintas", () => {
    const r = sugerirPagoJunto(3480.5, [f("a", 1160, "AAA010101AA1"), f("b", 2320.5, "BBB020202BB2")]);
    expect(r).toBeNull();
  });

  it("una sola factura no es pago junto (eso ya lo cubre el match normal)", () => {
    expect(sugerirPagoJunto(1160, [f("a", 1160), f("b", 500)])).toBeNull();
  });

  it("dos subconjuntos que suman igual = ambigüedad = silencio", () => {
    // 100+300 y 150+250 suman 400 en el mismo grupo.
    expect(sugerirPagoJunto(400, [f("a", 100), f("b", 300), f("c", 150), f("d", 250)])).toBeNull();
  });

  it("subconjuntos exactos en DOS contrapartes distintas también es ambigüedad", () => {
    const r = sugerirPagoJunto(400, [
      f("a", 100, "AAA010101AA1"), f("b", 300, "AAA010101AA1"),
      f("c", 150, "BBB020202BB2"), f("d", 250, "BBB020202BB2"),
    ]);
    expect(r).toBeNull();
  });

  it("saldos idénticos repetidos no cuentan como soluciones distintas (mismo multiset de montos)", () => {
    // Tres facturas de $500: {a,b}, {a,c}, {b,c} suman 1000 pero son el mismo
    // PAR de montos — se sugiere una combinación, no se declara ambigüedad.
    const r = sugerirPagoJunto(1000, [f("a", 500), f("b", 500), f("c", 500)]);
    expect(r).not.toBeNull();
    expect(r!.asignaciones).toHaveLength(2);
  });

  it("sin RFC no participa: identidad primero", () => {
    expect(sugerirPagoJunto(400, [f("a", 100, null as unknown as string), { id: "b", rfc: null, saldo: 300 }])).toBeNull();
  });

  it("respeta el tope de facturas por pago (6)", () => {
    const muchas = Array.from({ length: 8 }, (_, i) => f(`x${i}`, 100));
    expect(sugerirPagoJunto(800, muchas)).toBeNull();
  });

  it("caso patológico: cientos de saldos iguales no explota", () => {
    const inicio = Date.now();
    const muchas = Array.from({ length: 200 }, (_, i) => f(`x${i}`, 1234.56));
    sugerirPagoJunto(2469.12, muchas);
    expect(Date.now() - inicio).toBeLessThan(500);
  });

  it("usa el SALDO pendiente, no el total: complementa pagos parciales previos", () => {
    const r = sugerirPagoJunto(1500, [f("a", 1000), f("b", 500), f("c", 2000)]);
    expect(r!.asignaciones.map((a) => a.invoiceId).sort()).toEqual(["a", "b"]);
  });
});
