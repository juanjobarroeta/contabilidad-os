import { describe, it, expect } from "vitest";
import {
  calculatePueCollections,
  type PueIncome,
  type PueCollection,
  type PueTimingReview,
} from "./iva-pue-cobros";
const from = new Date("2026-09-01Z"),
  to = new Date("2026-10-01Z"),
  nov = new Date("2026-11-01Z");
const invoice: PueIncome = {
  id: "invoice",
  fecha: new Date("2026-10-01T18:00:00Z"),
  total: 14500,
  subtotal: 12500,
  descuento: 0,
  moneda: "MXN",
  formaPago: "03",
  ivaNoCausado: false,
  taxes: [
    {
      tipo: "IVA",
      factor: "TASA",
      tasa: 0.16,
      base: 12500,
      importe: 2000,
      retencion: false,
    },
  ],
  items: [],
};
const receipt = (
  id: string,
  fecha = "2026-09-30",
  monto = 14500,
): PueCollection => ({
  id,
  fecha: new Date(fecha + "T12:00:00Z"),
  monto,
  referencia: id,
});
const review: PueTimingReview = {
  version: 1,
  tratamiento: "FLUJO_GENERAL",
  fechaCobro: "2026-09-30",
  evidencia: "Synthetic receipt reference",
  motivo: "Reviewed ordinary interest contract",
  fingerprint: "x",
  actorId: "reviewer",
  reviewedAt: "2026-10-01T00:00:00Z",
};
describe("outgoing PUE collection timing", () => {
  it("handles year-end receipts and exclusive calendar boundaries without shifting by server timezone", () => {
    const dec = new Date("2025-12-01T00:00:00Z"),
      jan = new Date("2026-01-01T00:00:00Z"),
      feb = new Date("2026-02-01T00:00:00Z");
    const inv = { ...invoice, fecha: new Date("2026-01-01T12:00:00Z") };
    const paid = [receipt("year-end", "2025-12-31")];
    expect(calculatePueCollections(inv, paid, dec, jan)).toMatchObject({
      trasladado: 2000,
      determinado: true,
    });
    expect(calculatePueCollections(inv, paid, jan, feb).trasladado).toBe(0);
    const boundary = [{ ...paid[0], fecha: jan }];
    expect(calculatePueCollections(inv, boundary, dec, jan).trasladado).toBe(0);
    expect(calculatePueCollections(inv, boundary, jan, feb).trasladado).toBe(
      2000,
    );
  });
  it("places a prior-month collection in September, not October, and preserves invoice date", () => {
    const sept = calculatePueCollections(invoice, [receipt("a")], from, to);
    expect(sept).toMatchObject({
      trasladado: 2000,
      gravados: 12500,
      determinado: true,
      fechaCfdi: "2026-10-01",
    });
    expect(
      calculatePueCollections(invoice, [receipt("a")], to, nov),
    ).toMatchObject({ trasladado: 0, gravados: 0, determinado: true });
  });
  it("keeps two real same-amount payments and deduplicates only the same evidence ID", () => {
    const a = receipt("a", "2026-09-30", 7250),
      b = receipt("b", "2026-09-30", 7250);
    expect(calculatePueCollections(invoice, [a, b, a], from, to)).toMatchObject(
      { trasladado: 2000, determinado: true },
    );
  });
  it("does not recognize overpayments twice across months", () => {
    const receipts = [receipt("a"), receipt("b", "2026-10-02")];
    const sep = calculatePueCollections(invoice, receipts, from, to),
      oct = calculatePueCollections(invoice, receipts, to, nov);
    expect(sep.trasladado + oct.trasladado).toBe(2000);
    expect(sep.determinado).toBe(false);
    expect(oct.determinado).toBe(false);
  });
  it("conserves cents over multiple payment periods", () => {
    const inv = {
      ...invoice,
      total: 1,
      subtotal: 0.86,
      taxes: [{ ...invoice.taxes[0], base: 0.86, importe: 0.14 }],
    };
    const receipts = [
      receipt("a", "2026-08-31", 0.33),
      receipt("b", "2026-09-30", 0.33),
      receipt("c", "2026-10-01", 0.34),
    ];
    const values = [
      calculatePueCollections(inv, receipts, new Date("2026-08-01Z"), from),
      calculatePueCollections(inv, receipts, from, to),
      calculatePueCollections(inv, receipts, to, nov),
    ];
    expect(Math.round(values.reduce((s, r) => s + r.trasladado, 0) * 100)).toBe(
      14,
    );
  });
  it("never treats missing evidence as a confirmed zero or invoice-month payment", () => {
    const result = calculatePueCollections(invoice, [], to, nov);
    expect(result).toMatchObject({
      fuente: "SIN_EVIDENCIA",
      determinado: false,
      trasladado: 2000,
    });
    expect(result.incidencias.join(" ")).toContain("estimación");
  });
  it("uses documented full collection once and holds contradictory bank evidence", () => {
    expect(
      calculatePueCollections(invoice, [], from, to, review),
    ).toMatchObject({
      trasladado: 2000,
      determinado: true,
      fuente: "COBRO_DOCUMENTADO",
    });
    expect(
      calculatePueCollections(invoice, [receipt("a")], from, to, review)
        .trasladado,
    ).toBe(2000);
    expect(
      calculatePueCollections(
        invoice,
        [receipt("a", "2026-10-01")],
        from,
        to,
        review,
      ).determinado,
    ).toBe(false);
  });
  it("requires a reviewed legal treatment for interest, without inventing an exemption", () => {
    const inv = {
      ...invoice,
      items: [{ claveProdServ: "84121500", descripcion: "Intereses de mutuo" }],
    };
    expect(
      calculatePueCollections(inv, [receipt("a")], from, to).determinado,
    ).toBe(false);
    expect(
      calculatePueCollections(inv, [receipt("a")], from, to, review),
    ).toMatchObject({ trasladado: 2000, determinado: true });
    expect(
      calculatePueCollections(inv, [receipt("a")], from, to, {
        ...review,
        tratamiento: "REVISION_ESPECIAL",
      }).determinado,
    ).toBe(false);
  });
  it("moves zero-rated and exempt bases with collection, and client withholding too", () => {
    const inv = {
      ...invoice,
      total: 13000,
      taxes: [
        ...invoice.taxes,
        { ...invoice.taxes[0], importe: 1500, retencion: true },
      ],
    };
    expect(
      calculatePueCollections(
        inv,
        [receipt("a", "2026-09-30", 13000)],
        from,
        to,
      ),
    ).toMatchObject({ trasladado: 2000, retenido: 1500 });
    const exempt = {
      ...invoice,
      total: 12500,
      taxes: [{ ...invoice.taxes[0], factor: "EXENTO", tasa: 0, importe: 0 }],
    };
    expect(
      calculatePueCollections(
        exempt,
        [receipt("a", "2026-09-30", 12500)],
        from,
        to,
      ),
    ).toMatchObject({ trasladado: 0, gravados: 0, exentos: 12500 });
  });
  it("holds an excluded invoice contradicted by payment evidence", () => {
    expect(
      calculatePueCollections(
        { ...invoice, ivaNoCausado: true },
        [receipt("a")],
        from,
        to,
      ),
    ).toMatchObject({ trasladado: 0, determinado: false });
  });
});
