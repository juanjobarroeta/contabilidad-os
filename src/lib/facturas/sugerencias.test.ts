import { describe, it, expect } from "vitest";
import {
  aggregateConceptos,
  derivarTratamientoIva,
  tratamientoPorClave,
  type RawItem,
  type RawTax,
} from "./sugerencias";

function item(p: Partial<RawItem> & { fecha: Date }): RawItem {
  return {
    claveProdServ: "84111506",
    descripcion: "Servicio de consultoría",
    valorUnitario: 1000,
    claveUnidad: "E48",
    customerId: "cust-A",
    ...p,
  };
}

describe("aggregateConceptos", () => {
  it("collapses distinct conceptos and counts occurrences", () => {
    const items = [
      item({ fecha: new Date("2026-01-01") }),
      item({ fecha: new Date("2026-02-01") }),
      item({ fecha: new Date("2026-03-01") }),
    ];
    const out = aggregateConceptos(items, "cust-A");
    expect(out).toHaveLength(1);
    expect(out[0].vecesUsado).toBe(3);
    expect(out[0].ultimoUso).toBe(new Date("2026-03-01").toISOString());
  });

  it("normalizes descripción (case/whitespace) when grouping", () => {
    const items = [
      item({ fecha: new Date("2026-01-01"), descripcion: "Servicio de consultoría" }),
      item({ fecha: new Date("2026-02-01"), descripcion: "servicio de  consultoría " }),
    ];
    const out = aggregateConceptos(items, "cust-A");
    expect(out).toHaveLength(1);
    expect(out[0].vecesUsado).toBe(2);
  });

  it("keeps the most recent row's price/unit/casing", () => {
    const items = [
      item({ fecha: new Date("2026-01-01"), valorUnitario: 1000, claveUnidad: "E48" }),
      item({ fecha: new Date("2026-05-01"), valorUnitario: 1500, claveUnidad: "H87" }),
    ];
    const out = aggregateConceptos(items, "cust-A");
    expect(out[0].valorUnitario).toBe(1500);
    expect(out[0].claveUnidad).toBe("H87");
  });

  it("puts customer items first, then company-wide, without duplicates", () => {
    const items = [
      // customer A: one distinct concepto
      item({ fecha: new Date("2026-01-01"), customerId: "cust-A", claveProdServ: "AAA", descripcion: "Para A" }),
      // customer B: a different concepto, more recent
      item({ fecha: new Date("2026-06-01"), customerId: "cust-B", claveProdServ: "BBB", descripcion: "Para B" }),
    ];
    const out = aggregateConceptos(items, "cust-A");
    // A's concepto leads even though B's is more recent (customer-first bucket)
    expect(out[0].descripcion).toBe("Para A");
    // B's concepto still appears company-wide
    expect(out.map((c) => c.descripcion)).toContain("Para B");
    // no duplicate of A
    expect(out.filter((c) => c.descripcion === "Para A")).toHaveLength(1);
  });

  it("does not repeat a customer concepto in the company-wide tail", () => {
    const items = [
      item({ fecha: new Date("2026-01-01"), customerId: "cust-A", claveProdServ: "AAA", descripcion: "Shared" }),
      item({ fecha: new Date("2026-02-01"), customerId: "cust-B", claveProdServ: "AAA", descripcion: "Shared" }),
    ];
    const out = aggregateConceptos(items, "cust-A");
    expect(out).toHaveLength(1);
    // vecesUsado in the customer bucket only counts that customer's rows
    expect(out[0].vecesUsado).toBe(1);
  });

  it("orders by recency then frequency", () => {
    const items = [
      item({ fecha: new Date("2026-01-01"), claveProdServ: "OLD", descripcion: "Old freq", valorUnitario: 1 }),
      item({ fecha: new Date("2026-01-02"), claveProdServ: "OLD", descripcion: "Old freq", valorUnitario: 1 }),
      item({ fecha: new Date("2026-06-01"), claveProdServ: "NEW", descripcion: "New once", valorUnitario: 2 }),
    ];
    const out = aggregateConceptos(items, "cust-A");
    expect(out[0].descripcion).toBe("New once"); // recency wins over frequency
    expect(out[1].descripcion).toBe("Old freq");
  });

  it("respects the top cap", () => {
    const items = Array.from({ length: 30 }, (_, i) =>
      item({ fecha: new Date(2026, 0, i + 1), claveProdServ: `K${i}`, descripcion: `desc ${i}` })
    );
    expect(aggregateConceptos(items, "cust-A", 15)).toHaveLength(15);
  });

  it("handles no customerId (company-wide only)", () => {
    const items = [
      item({ fecha: new Date("2026-01-01"), customerId: "cust-A", descripcion: "A" }),
      item({ fecha: new Date("2026-02-01"), customerId: "cust-B", descripcion: "B" }),
    ];
    const out = aggregateConceptos(items, null);
    expect(out).toHaveLength(2);
  });

  it("carries the most recent row's ivaTratamiento (null when unknown)", () => {
    const items = [
      item({ fecha: new Date("2026-01-01"), ivaTratamiento: "16" }),
      item({ fecha: new Date("2026-05-01"), ivaTratamiento: "0" }),
    ];
    expect(aggregateConceptos(items, "cust-A")[0].ivaTratamiento).toBe("0");
    // Sin dato (fixtures viejos / borradores) → null, nunca un default inventado.
    expect(aggregateConceptos([item({ fecha: new Date("2026-01-01") })], "cust-A")[0].ivaTratamiento).toBeNull();
  });
});

// ── derivarTratamientoIva ─────────────────────────────────────────────────────

function tax(p: Partial<RawTax> = {}): RawTax {
  return { tipo: "IVA", factor: "TASA", tasa: 0.16, retencion: false, ...p };
}

describe("derivarTratamientoIva", () => {
  it("deriva 16 de un traslado IVA con tasa 0.16", () => {
    expect(derivarTratamientoIva([tax()])).toBe("16");
  });

  it("deriva tasa cero de un traslado IVA con tasa 0 y factor TASA", () => {
    expect(derivarTratamientoIva([tax({ tasa: 0 })])).toBe("0");
  });

  it("deriva EXENTO del factor EXENTO", () => {
    expect(derivarTratamientoIva([tax({ factor: "EXENTO", tasa: 0 })])).toBe("EXENTO");
  });

  it("regresa null sin traslados de IVA (facturas legacy con taxes vacíos)", () => {
    expect(derivarTratamientoIva([])).toBeNull();
  });

  it("ignora retenciones y otros impuestos al derivar", () => {
    const rows = [
      tax({ tasa: 0 }),
      tax({ retencion: true, tasa: 0.106667 }), // retención de IVA
      tax({ tipo: "ISR", retencion: true, tasa: 0.1 }),
    ];
    expect(derivarTratamientoIva(rows)).toBe("0");
  });

  it("regresa null cuando el comprobante mezcla tratamientos", () => {
    expect(derivarTratamientoIva([tax(), tax({ tasa: 0 })])).toBeNull();
    expect(derivarTratamientoIva([tax(), tax({ factor: "EXENTO", tasa: 0 })])).toBeNull();
  });

  it("regresa null ante tasas que el formulario no representa (8% frontera) o factor CUOTA", () => {
    expect(derivarTratamientoIva([tax({ tasa: 0.08 })])).toBeNull();
    expect(derivarTratamientoIva([tax({ factor: "CUOTA", tasa: 0.5 })])).toBeNull();
  });
});

// ── tratamientoPorClave ───────────────────────────────────────────────────────

describe("tratamientoPorClave", () => {
  it("toma el tratamiento del uso más reciente por clave", () => {
    const out = tratamientoPorClave([
      { claveProdServ: "50202301", fecha: new Date("2026-01-01"), ivaTratamiento: "16" },
      { claveProdServ: "50202301", fecha: new Date("2026-06-01"), ivaTratamiento: "0" },
      { claveProdServ: "84111506", fecha: new Date("2026-03-01"), ivaTratamiento: "16" },
    ]);
    expect(out).toEqual({ "50202301": "0", "84111506": "16" });
  });

  it("omite filas sin tratamiento derivado", () => {
    const out = tratamientoPorClave([
      { claveProdServ: "50202301", fecha: new Date("2026-06-01"), ivaTratamiento: null },
      { claveProdServ: "50202301", fecha: new Date("2026-01-01"), ivaTratamiento: "0" },
    ]);
    // La fila ambigua (null) más reciente no borra el dato conocido anterior.
    expect(out).toEqual({ "50202301": "0" });
  });

  it("regresa un mapa vacío sin datos", () => {
    expect(tratamientoPorClave([])).toEqual({});
  });
});
