import { describe, it, expect } from "vitest";
import { cuadreDeCfdis } from "./cuadre";

type Factura = { id: string; subtotal: number; tipoSat?: string };
type Unidad = { id: string; compraInvoiceId: string; costoCompra: number; descripcionCfdi?: string | null };
type Costo = { invoiceId: string; vehiculoId: string; monto: number; concepto: string };
type Mov = { invoiceId: string; cantidad: number; montoUnitario: number };

function fakeDb(d: { facturas: Factura[]; unidades?: Unidad[]; costos?: Costo[]; movs?: Mov[] }) {
  return {
    invoice: { findMany: async () => d.facturas.map((f) => ({ tipoSat: "I", ...f })) },
    vehiculo: {
      findMany: async () =>
        (d.unidades ?? []).map((u) => ({ descripcionCfdi: null, ...u })),
    },
    vehiculoCosto: { findMany: async () => d.costos ?? [] },
    refaccionMovimiento: { findMany: async () => d.movs ?? [] },
  } as never;
}

const D = new Date("2025-01-01");
const H = new Date("2026-01-01");

describe("cuadreDeCfdis — cada peso contado una vez", () => {
  it("una factura atribuida por completo cuadra y no deja residuo", async () => {
    const db = fakeDb({
      facturas: [{ id: "f1", subtotal: 500000 }],
      unidades: [{ id: "v1", compraInvoiceId: "f1", costoCompra: 500000 }],
    });
    const r = await cuadreDeCfdis(db, "c1", D, H);
    expect(r.egreso.completas).toEqual({ facturas: 1, monto: 500000 });
    expect(r.egreso.parciales.residuo).toBe(0);
    expect(r.egreso.sobreAtribuidas.facturas).toBe(0);
    expect(r.cuadra).toBe(true);
  });

  it("una factura sin liga alguna se reporta como gasto, no como descuadre", async () => {
    const db = fakeDb({ facturas: [{ id: "f1", subtotal: 12000 }] });
    const r = await cuadreDeCfdis(db, "c1", D, H);
    expect(r.egreso.sinAtribuir).toEqual({ facturas: 1, monto: 12000 });
    expect(r.cuadra).toBe(true);
  });

  it("delata el residuo que hoy no cuenta nadie en una factura atribuida a medias", async () => {
    // gastosDeOperacion excluye la factura ENTERA por tener liga, así que los
    // $30,000 no atribuidos desaparecen del estado de resultados.
    const db = fakeDb({
      facturas: [{ id: "f1", subtotal: 100000 }],
      unidades: [{ id: "v1", compraInvoiceId: "f1", costoCompra: 70000 }],
    });
    const r = await cuadreDeCfdis(db, "c1", D, H);
    expect(r.egreso.parciales).toEqual({ facturas: 1, atribuido: 70000, residuo: 30000 });
    expect(r.cuadra).toBe(true);
  });

  it("detecta el fan-out: la factura de 30 unidades cargada entera a una sola", async () => {
    // El caso real de MARGOM. Subtotal $25,810,344.83; una fila se lleva la
    // factura completa y las hermanas $1,720,689.65 (= subtotal / 15).
    const subtotal = 25810344.83;
    const costos: Costo[] = [
      { invoiceId: "f1", vehiculoId: "v1", monto: 25810344.82, concepto: "Conversión y Equipamiento para 30 vehiculos" },
      ...Array.from({ length: 14 }, (_, i) => ({
        invoiceId: "f1",
        vehiculoId: `v${i + 2}`,
        monto: 1720689.65,
        concepto: "Conversión y Equipamiento para 30 vehiculos",
      })),
    ];
    const db = fakeDb({ facturas: [{ id: "f1", subtotal }], costos });
    const r = await cuadreDeCfdis(db, "c1", D, H);

    expect(r.egreso.sobreAtribuidas.facturas).toBe(1);
    // Se le cargó la factura entera MÁS otras catorce quinceavas partes:
    // 25,810,344.82 + 14 × 1,720,689.65 = 49,899,999.92 sobre un CFDI de
    // 25,810,344.83. El exceso es dinero que no existe en ningún documento.
    expect(r.egreso.sobreAtribuidas.exceso).toBeCloseTo(24089655.09, 2);
    const peor = r.egreso.sobreAtribuidas.peores[0];
    expect(peor.unidades).toBe(15);
    expect(peor.concepto).toContain("30 vehiculos");
  });

  it("una nota de crédito de proveedor no cuenta como sobre-atribución", async () => {
    // NC recibida: vale en negativo y netea el costo. Compararla contra un
    // subtotal positivo la haría ver como dinero inventado.
    const db = fakeDb({
      facturas: [{ id: "nc1", subtotal: 40000, tipoSat: "E" }],
      costos: [{ invoiceId: "nc1", vehiculoId: "v1", monto: -40000, concepto: "Bonificación" }],
    });
    const r = await cuadreDeCfdis(db, "c1", D, H);
    expect(r.egreso.sobreAtribuidas.facturas).toBe(0);
    expect(r.egreso.completas.facturas).toBe(1);
  });

  it("suma las tres fuentes de atribución sobre la misma factura", async () => {
    // Un CFDI puede amparar la unidad Y sus accesorios Y refacciones: el
    // invariante es por factura, no por fuente.
    const db = fakeDb({
      facturas: [{ id: "f1", subtotal: 100000 }],
      unidades: [{ id: "v1", compraInvoiceId: "f1", costoCompra: 60000 }],
      costos: [{ invoiceId: "f1", vehiculoId: "v1", monto: 30000, concepto: "Accesorios" }],
      movs: [{ invoiceId: "f1", cantidad: 10, montoUnitario: 1000 }],
    });
    const r = await cuadreDeCfdis(db, "c1", D, H);
    expect(r.egreso.completas).toEqual({ facturas: 1, monto: 100000 });
    expect(r.cuadra).toBe(true);
  });

  it("tolera el centavo de redondeo del CFDI", async () => {
    const db = fakeDb({
      facturas: [{ id: "f1", subtotal: 1000 }],
      unidades: [{ id: "v1", compraInvoiceId: "f1", costoCompra: 1000.004 }],
    });
    const r = await cuadreDeCfdis(db, "c1", D, H);
    expect(r.egreso.completas.facturas).toBe(1);
    expect(r.egreso.sobreAtribuidas.facturas).toBe(0);
  });
});
