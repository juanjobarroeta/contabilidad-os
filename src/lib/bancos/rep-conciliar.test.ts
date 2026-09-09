import { describe, expect, it } from "vitest";
import { agruparPagos, elegirPagoRep, type PagoRep } from "./rep-conciliar";

const F = (s: string) => new Date(s + "T12:00:00.000Z");

function pago(over: Partial<PagoRep> = {}): PagoRep {
  return {
    repId: "rep-1",
    fechaPago: F("2026-08-07"),
    rfcContraparte: "FES9012301AA",
    total: 268184.33,
    docs: [
      { invoiceId: "inv-1", uuid: "u-1", impPagado: 168184.33, tipoPadre: "EGRESO" },
      { invoiceId: "inv-2", uuid: "u-2", impPagado: 100000, tipoPadre: "EGRESO" },
    ],
    ...over,
  };
}

const mov = { fecha: F("2026-08-07"), monto: -268184.33, contraparteRfc: "FES9012301AA" };

describe("elegirPagoRep — el desglose lo firmó el emisor", () => {
  it("empata importe, RFC y fecha → elegido, con su desglose", () => {
    const r = elegirPagoRep(mov, [pago()]);
    expect(r.estado).toBe("elegido");
    if (r.estado === "elegido") {
      expect(r.pago.docs).toHaveLength(2);
      expect(r.pago.docs.reduce((s, d) => s + d.impPagado, 0)).toBeCloseTo(268184.33, 2);
    }
  });

  it("el REP se emite hasta el día 5 del mes siguiente: la fecha puede ir lejos", () => {
    expect(elegirPagoRep(mov, [pago({ fechaPago: F("2026-09-05") })]).estado).toBe("elegido");
  });

  it("fuera de la ventana no", () => {
    expect(elegirPagoRep(mov, [pago({ fechaPago: F("2026-11-20") })]).estado).toBe("sin_candidato");
  });

  it("un centavo de diferencia descalifica: el REP declara el importe exacto", () => {
    expect(elegirPagoRep(mov, [pago({ total: 268184.34 })]).estado).toBe("sin_candidato");
  });

  it("RFC distinto descalifica", () => {
    expect(elegirPagoRep(mov, [pago({ rfcContraparte: "PIS8001015AA" })]).estado).toBe("sin_candidato");
  });

  it("sin RFC en el movimiento NO descalifica — el banco casi nunca lo imprime", () => {
    const sinRfc = { ...mov, contraparteRfc: null };
    expect(elegirPagoRep(sinRfc, [pago()]).estado).toBe("elegido");
  });

  it("el sentido manda: un retiro no cobra facturas de ingreso", () => {
    const cobro = pago({
      docs: [{ invoiceId: "inv-9", uuid: "u-9", impPagado: 268184.33, tipoPadre: "INGRESO" }],
    });
    expect(elegirPagoRep(mov, [cobro]).estado).toBe("sin_candidato");
    // …y el depósito espejo sí lo toma.
    const deposito = { ...mov, monto: 268184.33 };
    expect(elegirPagoRep(deposito, [cobro]).estado).toBe("elegido");
  });

  it("dos REP por el mismo importe (parcialidades iguales) → ambiguo, no se aplica", () => {
    const r = elegirPagoRep(mov, [pago(), pago({ repId: "rep-2" })]);
    expect(r.estado).toBe("ambiguo");
    if (r.estado === "ambiguo") expect(r.pagos).toHaveLength(2);
  });

  it("si falta un CFDI del desglose no se aplica a medias: repartiría mal el IVA", () => {
    const conHueco = pago({
      docs: [
        { invoiceId: "inv-1", uuid: "u-1", impPagado: 168184.33, tipoPadre: "EGRESO" },
        { invoiceId: null, uuid: "u-2", impPagado: 100000, tipoPadre: null },
      ],
    });
    const r = elegirPagoRep(mov, [conHueco]);
    expect(r.estado).toBe("incompleto");
    if (r.estado === "incompleto") expect(r.faltantes).toEqual(["u-2"]);
  });
});

describe("agruparPagos — un REP puede llevar varios pagos", () => {
  const rep = { id: "rep-1", fecha: F("2026-09-05"), rfcContraparte: "PIS8001015AA" };

  it("separa por fecha de pago, no por comprobante", () => {
    const pagos = agruparPagos(rep, [
      { uuid: "a", impPagado: 1000, fechaPago: F("2026-08-10"), invoiceId: "i-a", tipoPadre: "EGRESO" },
      { uuid: "b", impPagado: 500, fechaPago: F("2026-08-10"), invoiceId: "i-b", tipoPadre: "EGRESO" },
      { uuid: "c", impPagado: 2000, fechaPago: F("2026-08-25"), invoiceId: "i-c", tipoPadre: "EGRESO" },
    ]);
    expect(pagos).toHaveLength(2);
    expect(pagos.find((p) => p.total === 1500)?.docs).toHaveLength(2);
    expect(pagos.find((p) => p.total === 2000)?.docs).toHaveLength(1);
  });

  it("sin fecha de pago cae a la del REP en vez de perder el desglose", () => {
    const pagos = agruparPagos(rep, [
      { uuid: "a", impPagado: 300, fechaPago: null, invoiceId: "i-a", tipoPadre: "EGRESO" },
    ]);
    expect(pagos).toHaveLength(1);
    expect(pagos[0].fechaPago.toISOString()).toBe(rep.fecha.toISOString());
  });

  it("un pago que liquida 21 facturas se conserva entero", () => {
    const docs = Array.from({ length: 21 }, (_, i) => ({
      uuid: `u-${i}`, impPagado: 100, fechaPago: F("2026-08-15"), invoiceId: `i-${i}`, tipoPadre: "EGRESO",
    }));
    const pagos = agruparPagos(rep, docs);
    expect(pagos).toHaveLength(1);
    expect(pagos[0].docs).toHaveLength(21);
    expect(pagos[0].total).toBe(2100);
  });
});

describe("sin RFC, un importe redondo no basta", () => {
  const redondo = { fecha: F("2026-08-14"), monto: 40000, contraparteRfc: null };

  it("un traspaso de $40,000.00 sin RFC no se liga a un REP de $40,000.00", () => {
    // Caso real de la primera corrida: «TRASPASO CUENTAS PROPIAS» empatando
    // con el REP de un cliente. Los importes redondos coinciden solos.
    const p = pago({ total: 40000, docs: [{ invoiceId: "i", uuid: "u", impPagado: 40000, tipoPadre: "INGRESO" }] });
    expect(elegirPagoRep(redondo, [p]).estado).toBe("sin_candidato");
  });

  it("con RFC sí, porque la identidad ya respalda", () => {
    const p = pago({
      total: 40000, rfcContraparte: "XAXX010101000",
      docs: [{ invoiceId: "i", uuid: "u", impPagado: 40000, tipoPadre: "INGRESO" }],
    });
    expect(elegirPagoRep({ ...redondo, contraparteRfc: "XAXX010101000" }, [p]).estado).toBe("elegido");
  });

  it("sin RFC pero con centavos sí: el importe es la huella", () => {
    const conCentavos = { fecha: F("2026-08-21"), monto: -175904.65, contraparteRfc: null };
    const p = pago({
      total: 175904.65,
      docs: [{ invoiceId: "i", uuid: "u", impPagado: 175904.65, tipoPadre: "EGRESO" }],
    });
    expect(elegirPagoRep(conCentavos, [p]).estado).toBe("elegido");
  });
});
