import { describe, expect, it } from "vitest";
import {
  emparejarRep,
  estadoDeFactura,
  estadoDeMovimiento,
  resumirFactura,
  resumirMovimiento,
  type CuentaLigera,
  type FacturaLigera,
  type LineaRep,
  type MovimientoLigero,
} from "./aplicaciones";

const cuenta: CuentaLigera = { id: "cta", banco: "BBVA", nombre: "Cheques", numeroCuenta: "1234" };
const d = (s: string) => new Date(`${s}T00:00:00Z`);

const factura = (over: Partial<FacturaLigera> = {}): FacturaLigera => ({
  id: "f1", uuid: "AAAA-1", serie: "HH", folio: "1440", fecha: d("2026-08-20"), total: 6468.97, tipo: "INGRESO",
  metodoPago: "PPD", contraparteNombre: "ORTEGA", contraparteRfc: "XAXX010101000", ...over,
});
const mov = (over: Partial<MovimientoLigero> = {}): MovimientoLigero => ({
  id: "t1", fecha: d("2026-08-01"), descripcion: "SPEI ORTEGA", monto: 2610, status: "MATCHED", cuenta,
  contraparteNombre: "ORTEGA", contraparteRfc: null, claveRastreo: null, ...over,
});
const linea = (over: Partial<LineaRep> = {}): LineaRep => ({
  id: "l1", repUuid: "REP-1", numParcialidad: 1, impPagado: 2610, impSaldoInsoluto: 3858.97, fechaPago: d("2026-08-01"), ...over,
});

describe("estadoDeMovimiento", () => {
  it("sin nada aplicado: SIN_APLICAR, o CATEGORIZADO si se ignoró con etiqueta", () => {
    expect(estadoDeMovimiento("UNMATCHED", 100, 0)).toBe("SIN_APLICAR");
    expect(estadoDeMovimiento("IGNORED", 100, 0)).toBe("CATEGORIZADO");
  });
  it("PARCIAL cuando lo aplicado no cubre el original; COMPLETO al centavo", () => {
    expect(estadoDeMovimiento("MATCHED", 25000, 10000)).toBe("PARCIAL");
    expect(estadoDeMovimiento("MATCHED", 25000, 24999.995)).toBe("COMPLETO");
    expect(estadoDeMovimiento("MATCHED", 25000, 25000)).toBe("COMPLETO");
  });
  it("un impuesto conciliado cierra el movimiento aunque no haya facturas", () => {
    expect(estadoDeMovimiento("MATCHED", 70312, 0, true)).toBe("COMPLETO");
  });
});

describe("estadoDeFactura", () => {
  it("SIN_APLICAR → PARCIAL → COMPLETO con tolerancia de un centavo", () => {
    expect(estadoDeFactura(6468.97, 0)).toBe("SIN_APLICAR");
    expect(estadoDeFactura(6468.97, 2610)).toBe("PARCIAL");
    expect(estadoDeFactura(6468.97, 6468.96)).toBe("COMPLETO");
  });
});

describe("emparejarRep", () => {
  it("PUE no lleva REP", () => {
    expect(emparejarRep({ monto: 100, fecha: d("2026-08-01") }, "PUE", [linea({ impPagado: 100 })], new Set())).toEqual({ estado: "NO_APLICA" });
  });
  it("PPD sin línea que coincida: SIN_REP", () => {
    expect(emparejarRep({ monto: 2610, fecha: d("2026-08-01") }, "PPD", [], new Set())).toEqual({ estado: "SIN_REP" });
    expect(emparejarRep({ monto: 2610, fecha: d("2026-08-01") }, "PPD", [linea({ impPagado: 2600 })], new Set())).toEqual({ estado: "SIN_REP" });
  });
  it("empata por importe al centavo y fecha dentro de la ventana; fuera de ventana no", () => {
    const usadas = new Set<string>();
    const r = emparejarRep({ monto: 2610, fecha: d("2026-08-01") }, "PPD", [linea({ fechaPago: d("2026-09-04") })], usadas);
    expect(r.estado).toBe("AMPARADA");
    expect(usadas.has("l1")).toBe(true);
    expect(emparejarRep({ monto: 2610, fecha: d("2026-08-01") }, "PPD", [linea({ id: "l2", fechaPago: d("2027-01-01") })], new Set())).toEqual({ estado: "SIN_REP" });
  });
  it("con varias que cumplen, la de fecha más cercana; y cada línea ampara un solo abono", () => {
    const lineas = [linea({ id: "lejos", fechaPago: d("2026-09-20") }), linea({ id: "cerca", fechaPago: d("2026-08-02") })];
    const usadas = new Set<string>();
    const a = emparejarRep({ monto: 2610, fecha: d("2026-08-01") }, "PPD", lineas, usadas);
    expect(a.estado === "AMPARADA" && usadas.has("cerca")).toBe(true);
    const b = emparejarRep({ monto: 2610, fecha: d("2026-08-01") }, "PPD", lineas, usadas);
    expect(b.estado === "AMPARADA" && usadas.has("lejos")).toBe(true);
    expect(emparejarRep({ monto: 2610, fecha: d("2026-08-01") }, "PPD", lineas, usadas)).toEqual({ estado: "SIN_REP" });
  });
});

describe("resumirMovimiento", () => {
  it("un abono parcial: restante y PARCIAL, con su REP", () => {
    const r = resumirMovimiento({
      movimiento: mov({ monto: 2610 }), cep: null, facturaUnoAUno: null,
      porciones: [{ id: "d1", montoAsignado: 2610, createdAt: d("2026-08-02"), factura: factura() }],
      repsPorFactura: new Map([["AAAA-1", [linea()]]]),
      impuesto: null,
    });
    expect(r.original).toBe(2610);
    expect(r.asignado).toBe(2610);
    expect(r.restante).toBe(0);
    expect(r.estado).toBe("COMPLETO");
    expect(r.aplicaciones[0].origen).toBe("PORCION");
    expect(r.aplicaciones[0].rep.estado).toBe("AMPARADA");
  });
  it("$10,000 aplicados de $25,000: PARCIAL y $15,000 restantes", () => {
    const r = resumirMovimiento({
      movimiento: mov({ monto: 25000 }), cep: null, facturaUnoAUno: null,
      porciones: [{ id: "d1", montoAsignado: 10000, createdAt: null, factura: factura({ metodoPago: "PUE" }) }],
      repsPorFactura: new Map(), impuesto: null,
    });
    expect(r.estado).toBe("PARCIAL");
    expect(r.restante).toBe(15000);
    expect(r.aplicaciones[0].rep).toEqual({ estado: "NO_APLICA" });
  });
  it("el vínculo 1:1 legado cuenta como una aplicación por el importe completo", () => {
    const r = resumirMovimiento({
      movimiento: mov({ monto: -6468.97, status: "MATCHED" }), cep: null, facturaUnoAUno: factura({ tipo: "EGRESO" }),
      porciones: [], repsPorFactura: new Map(), impuesto: null,
    });
    expect(r.aplicaciones).toHaveLength(1);
    expect(r.aplicaciones[0].origen).toBe("UNO_A_UNO");
    expect(r.aplicaciones[0].id).toBe("1:1:t1");
    expect(r.aplicaciones[0].monto).toBe(6468.97);
    expect(r.estado).toBe("COMPLETO");
  });
  it("si hay porciones, el 1:1 no se duplica", () => {
    const r = resumirMovimiento({
      movimiento: mov({ monto: 2610 }), cep: null, facturaUnoAUno: factura(),
      porciones: [{ id: "d1", montoAsignado: 2610, createdAt: null, factura: factura() }],
      repsPorFactura: new Map(), impuesto: null,
    });
    expect(r.aplicaciones).toHaveLength(1);
    expect(r.asignado).toBe(2610);
  });
  it("sin aplicar, o categorizado sin factura", () => {
    expect(resumirMovimiento({ movimiento: mov({ status: "UNMATCHED" }), cep: null, facturaUnoAUno: null, porciones: [], repsPorFactura: new Map(), impuesto: null }).estado).toBe("SIN_APLICAR");
    expect(resumirMovimiento({ movimiento: mov({ status: "IGNORED" }), cep: null, facturaUnoAUno: null, porciones: [], repsPorFactura: new Map(), impuesto: null }).estado).toBe("CATEGORIZADO");
  });
  it("un impuesto conciliado cierra el movimiento", () => {
    const r = resumirMovimiento({
      movimiento: mov({ monto: -70312 }), cep: null, facturaUnoAUno: null, porciones: [], repsPorFactura: new Map(),
      impuesto: { id: "td", etiqueta: "IVA julio 2026", status: "PAID" },
    });
    expect(r.estado).toBe("COMPLETO");
    expect(r.impuesto?.etiqueta).toBe("IVA julio 2026");
  });
});

describe("resumirFactura", () => {
  it("dos abonos a la misma factura: aplicado, disponible, PARCIAL, y el REP por abono", () => {
    const r = resumirFactura({
      factura: factura(),
      unoAUno: [],
      porciones: [
        { id: "d2", montoAsignado: 1000, createdAt: null, movimiento: mov({ id: "t2", fecha: d("2026-08-15"), monto: 1000 }) },
        { id: "d1", montoAsignado: 2610, createdAt: null, movimiento: mov({ id: "t1", fecha: d("2026-08-01"), monto: 2610 }) },
      ],
      lineasRep: [linea({ id: "l1", impPagado: 2610, numParcialidad: 1, impSaldoInsoluto: 3858.97, fechaPago: d("2026-08-01") })],
    });
    expect(r.aplicado).toBe(3610);
    expect(r.disponible).toBe(2858.97);
    expect(r.estado).toBe("PARCIAL");
    // Cronológico: primero el 01/08.
    expect(r.aplicaciones.map((a) => a.movimiento.id)).toEqual(["t1", "t2"]);
    expect(r.aplicaciones[0].rep.estado).toBe("AMPARADA");
    expect(r.aplicaciones[1].rep.estado).toBe("SIN_REP");
    expect(r.rep).toEqual({ lineas: 1, amparado: 2610, ultimaParcialidad: 1, saldoInsoluto: 3858.97 });
  });
  it("1:1 legado y porción del mismo movimiento: la porción gana", () => {
    const t = mov({ id: "t1", monto: 2610 });
    const r = resumirFactura({
      factura: factura({ metodoPago: "PUE" }),
      unoAUno: [t],
      porciones: [{ id: "d1", montoAsignado: 2000, createdAt: null, movimiento: t }],
      lineasRep: [],
    });
    expect(r.aplicaciones).toHaveLength(1);
    expect(r.aplicado).toBe(2000);
  });
  it("sin abonos: SIN_APLICAR y todo disponible", () => {
    const r = resumirFactura({ factura: factura(), unoAUno: [], porciones: [], lineasRep: [] });
    expect(r.estado).toBe("SIN_APLICAR");
    expect(r.disponible).toBe(6468.97);
  });
  it("la última parcialidad y su saldo insoluto vienen de la línea de mayor número", () => {
    const r = resumirFactura({
      factura: factura(), unoAUno: [], porciones: [],
      lineasRep: [linea({ id: "l2", numParcialidad: 2, impPagado: 1000, impSaldoInsoluto: 2858.97 }), linea({ id: "l1", numParcialidad: 1 })],
    });
    expect(r.rep.ultimaParcialidad).toBe(2);
    expect(r.rep.saldoInsoluto).toBe(2858.97);
    expect(r.rep.amparado).toBe(3610);
  });
});
