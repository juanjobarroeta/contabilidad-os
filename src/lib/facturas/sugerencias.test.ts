import { describe, it, expect } from "vitest";
import {
  aggregateConceptos,
  agruparFacturasRecurrentes,
  derivarTratamientoIva,
  firmaFactura,
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

// ─────────────────────────────────────────────────────────────────────────────
// Facturación recurrente («vuelve a facturar»)
// ─────────────────────────────────────────────────────────────────────────────

describe("firmaFactura", () => {
  const base = { id: "x", fecha: new Date("2026-01-31"), total: 100, cliente: "Ana" };

  it("no depende del orden ni del formato de la descripción", () => {
    const a = firmaFactura({
      ...base,
      customerId: "c1",
      items: [
        { claveProdServ: "80131502", descripcion: "Renta local", cantidad: 1, valorUnitario: 100, claveUnidad: "E48" },
        { claveProdServ: "84111506", descripcion: "Mantenimiento", cantidad: 1, valorUnitario: 50, claveUnidad: "E48" },
      ],
    });
    const b = firmaFactura({
      ...base,
      customerId: "c1",
      items: [
        { claveProdServ: "84111506", descripcion: "  MANTENIMIENTO ", cantidad: 1, valorUnitario: 50, claveUnidad: "E48" },
        { claveProdServ: "80131502", descripcion: "renta   local", cantidad: 1, valorUnitario: 100, claveUnidad: "E48" },
      ],
    });
    expect(a).toBe(b);
  });

  it("distingue clientes distintos con los mismos conceptos", () => {
    const items = [{ claveProdServ: "80131502", descripcion: "Renta", cantidad: 1, valorUnitario: 100, claveUnidad: "E48" }];
    expect(firmaFactura({ ...base, customerId: "c1", items })).not.toBe(
      firmaFactura({ ...base, customerId: "c2", items })
    );
  });
});

describe("agruparFacturasRecurrentes", () => {
  const renta = (id: string, fecha: string, valorUnitario = 12000, cuentaPredial = "0102030405") => ({
    id,
    fecha: new Date(fecha),
    total: valorUnitario * 1.16,
    customerId: "c1",
    cliente: "Ana Rentera",
    ivaTratamiento: "16" as const,
    items: [
      { claveProdServ: "80131502", descripcion: "Renta local comercial", cantidad: 1, valorUnitario, claveUnidad: "E48", cuentaPredial },
    ],
  });

  it("cuenta las veces que se repite la misma forma de factura", () => {
    const r = agruparFacturasRecurrentes([
      renta("f1", "2026-01-31"),
      renta("f2", "2026-02-28"),
      renta("f3", "2026-03-31"),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].veces).toBe(3);
    expect(r[0].cliente).toBe("Ana Rentera");
  });

  it("la plantilla es la factura MÁS RECIENTE (precios al día)", () => {
    const r = agruparFacturasRecurrentes([
      renta("f1", "2026-01-31", 12000),
      renta("f3", "2026-03-31", 13500), // subió la renta
      renta("f2", "2026-02-28", 12000),
    ]);
    expect(r[0].facturaId).toBe("f3");
    expect(r[0].items[0].valorUnitario).toBe(13500);
    expect(r[0].ultimoUso.slice(0, 10)).toBe("2026-03-31");
  });

  it("arrastra la cuenta predial para que el arrendamiento se re-facture solo", () => {
    const r = agruparFacturasRecurrentes([renta("f1", "2026-01-31")]);
    expect(r[0].items[0].cuentaPredial).toBe("0102030405");
  });

  it("ordena por frecuencia y desempata por recencia", () => {
    const otra = {
      id: "g1",
      fecha: new Date("2026-04-30"),
      total: 500,
      customerId: "c2",
      cliente: "Beto",
      ivaTratamiento: "16" as const,
      items: [{ claveProdServ: "84111506", descripcion: "Consultoría", cantidad: 1, valorUnitario: 500, claveUnidad: "E48" }],
    };
    const r = agruparFacturasRecurrentes([renta("f1", "2026-01-31"), renta("f2", "2026-02-28"), otra]);
    expect(r.map((x) => x.cliente)).toEqual(["Ana Rentera", "Beto"]);
  });

  it("respeta el tope y descarta facturas sin conceptos", () => {
    const vacia = { id: "v", fecha: new Date("2026-05-31"), total: 0, customerId: "c9", cliente: "Vacía", items: [] };
    const r = agruparFacturasRecurrentes([renta("f1", "2026-01-31"), vacia], 1);
    expect(r).toHaveLength(1);
    expect(r[0].cliente).toBe("Ana Rentera");
  });

  it("sin tratamiento de IVA derivable conserva 16%", () => {
    const sinIva = { ...renta("f1", "2026-01-31"), ivaTratamiento: null };
    expect(agruparFacturasRecurrentes([sinIva])[0].ivaTratamiento).toBe("16");
  });
});

describe("agruparFacturasRecurrentes — facturas sin cliente", () => {
  const sinCliente = {
    id: "sat-1",
    fecha: new Date("2026-06-15"),
    total: 7236.97,
    customerId: null,
    cliente: "Sin cliente",
    ivaTratamiento: "16" as const,
    items: [
      { claveProdServ: "86121800", descripcion: "Programas de entrenamiento", cantidad: 1, valorUnitario: 6238.77, claveUnidad: "E48" },
    ],
  };

  it("NO las ofrece: sin cliente ligado el formulario no puede arrancar", () => {
    // Caso real: CFDIs que entran por descarga masiva del SAT sin emparejar con
    // un Customer. Ofrecerlos dejaba tarjetas que al hacer clic sólo daban error.
    expect(agruparFacturasRecurrentes([sinCliente])).toEqual([]);
  });

  it("las descarta sin estorbar a las que sí tienen cliente", () => {
    const conCliente = { ...sinCliente, id: "f1", customerId: "c1", cliente: "Ana Rentera" };
    const r = agruparFacturasRecurrentes([sinCliente, conCliente]);
    expect(r).toHaveLength(1);
    expect(r[0].cliente).toBe("Ana Rentera");
  });
});
