import { describe, it, expect } from "vitest";
import { aggregateConceptos, type RawItem } from "./sugerencias";

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
});
