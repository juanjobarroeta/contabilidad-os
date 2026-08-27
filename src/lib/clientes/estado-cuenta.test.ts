import { describe, expect, it } from "vitest";
import { armarEstadoDeCuenta, type FacturaInput, type CobroInput } from "./estado-cuenta";

const d = (s: string) => new Date(`${s}T12:00:00Z`);

function factura(over: Partial<FacturaInput>): FacturaInput {
  return {
    id: "f1",
    uuid: "uuid-f1",
    fecha: d("2026-08-05"),
    referencia: "A-101",
    total: 1160,
    esNotaCredito: false,
    ...over,
  };
}

function cobro(over: Partial<CobroInput>): CobroInput {
  return { fecha: d("2026-08-15"), descripcion: "SPEI recibido", invoiceId: "f1", monto: 1160, ...over };
}

const rango = { desde: d("2026-08-01"), hasta: d("2026-08-31"), hoy: d("2026-09-10") };

describe("armarEstadoDeCuenta — saldo corrido y totales", () => {
  it("factura + cobro completo: saldo final cero, corrido correcto", () => {
    const e = armarEstadoDeCuenta({
      facturas: [factura({})],
      cobros: [cobro({})],
      repsPorUuid: new Set(),
      ...rango,
    });
    expect(e.saldoInicial).toBe(0);
    expect(e.cargos).toBe(1160);
    expect(e.abonos).toBe(1160);
    expect(e.saldoFinal).toBe(0);
    expect(e.movimientos.map((m) => [m.tipo, m.saldo])).toEqual([
      ["FACTURA", 1160],
      ["COBRO", 0],
    ]);
    expect(e.abiertas).toEqual([]);
  });

  it("la historia previa al rango se comprime en saldo inicial", () => {
    const e = armarEstadoDeCuenta({
      facturas: [
        factura({ id: "vieja", uuid: "u-v", fecha: d("2026-06-10"), referencia: "A-90", total: 500 }),
        factura({}),
      ],
      cobros: [cobro({ invoiceId: "vieja", fecha: d("2026-07-01"), monto: 200 })],
      repsPorUuid: new Set(),
      ...rango,
    });
    expect(e.saldoInicial).toBe(300); // 500 − 200 antes de agosto
    expect(e.movimientos).toHaveLength(1); // sólo la factura de agosto entra al rango
    expect(e.saldoFinal).toBe(300 + 1160);
  });

  it("el mismo día, la factura entra antes que su cobro (orden estable)", () => {
    const e = armarEstadoDeCuenta({
      facturas: [factura({ fecha: d("2026-08-15") })],
      cobros: [cobro({ fecha: d("2026-08-15") })],
      repsPorUuid: new Set(),
      ...rango,
    });
    expect(e.movimientos[0].tipo).toBe("FACTURA");
    expect(e.movimientos[1].saldo).toBe(0);
  });
});

describe("abiertas, antigüedad y avisos", () => {
  it("cobro parcial: la factura queda abierta por el resto, con su bucket", () => {
    const e = armarEstadoDeCuenta({
      facturas: [factura({ fecha: d("2026-08-05") })],
      cobros: [cobro({ monto: 500 })],
      repsPorUuid: new Set(),
      ...rango,
    });
    expect(e.abiertas).toHaveLength(1);
    expect(e.abiertas[0]).toMatchObject({ total: 1160, cobrado: 500, saldo: 660, diasVencida: 36 });
    expect(e.aging["31-60"]).toBe(660);
    expect(e.aging["0-30"]).toBe(0);
  });

  it("REP emitido sin cobro bancario: marcador en la factura y aviso", () => {
    const e = armarEstadoDeCuenta({
      facturas: [factura({})],
      cobros: [],
      repsPorUuid: new Set(["uuid-f1"]),
      ...rango,
    });
    expect(e.abiertas[0].repEmitido).toBe(true);
    expect(e.avisos.some((a) => a.includes("REP"))).toBe(true);
  });

  it("nota de crédito: abona al corrido, no toca abiertas, y avisa", () => {
    const e = armarEstadoDeCuenta({
      facturas: [
        factura({}),
        factura({ id: "nc", uuid: "u-nc", referencia: "NC-1", fecha: d("2026-08-20"), total: 160, esNotaCredito: true }),
      ],
      cobros: [],
      repsPorUuid: new Set(),
      ...rango,
    });
    expect(e.saldoFinal).toBe(1000); // 1160 − 160
    expect(e.notasCreditoPeriodo).toBe(160);
    expect(e.abiertas).toHaveLength(1);
    expect(e.abiertas[0].saldo).toBe(1160); // la NC no se aplica por factura
    expect(e.avisos.some((a) => a.includes("notas de crédito"))).toBe(true);
  });

  it("sobre-cobro no vuelve negativo el saldo de la factura", () => {
    const e = armarEstadoDeCuenta({
      facturas: [factura({})],
      cobros: [cobro({ monto: 1500 })],
      repsPorUuid: new Set(),
      ...rango,
    });
    expect(e.abiertas).toEqual([]); // cobrada; el excedente vive en el corrido
    expect(e.saldoFinal).toBe(-340);
  });
});
