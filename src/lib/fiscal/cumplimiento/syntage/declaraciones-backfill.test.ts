import { describe, it, expect } from "vitest";
import { mesDePeriodo, fileRefDe, tiposSinDato } from "./declaraciones-backfill";

describe("mesDePeriodo (Syntage `period` → mes 1-12)", () => {
  it("parses Spanish month names (with/without accents, case-insensitive)", () => {
    expect(mesDePeriodo("Diciembre")).toBe(12);
    expect(mesDePeriodo("enero")).toBe(1);
    expect(mesDePeriodo("Septiembre")).toBe(9);
    expect(mesDePeriodo("setiembre")).toBe(9);
  });
  it("parses numeric periods", () => {
    expect(mesDePeriodo("03")).toBe(3);
    expect(mesDePeriodo("3")).toBe(3);
    expect(mesDePeriodo(7)).toBe(7);
  });
  it("rejects out-of-range and unknown values", () => {
    expect(mesDePeriodo(0)).toBeNull();
    expect(mesDePeriodo(13)).toBeNull();
    expect(mesDePeriodo("trimestre")).toBeNull();
    expect(mesDePeriodo(null)).toBeNull();
    expect(mesDePeriodo(undefined)).toBeNull();
  });
});

describe("fileRefDe (acuse ref from tax-return files[])", () => {
  it("prefers @id, then resource, then builds /files/{id}", () => {
    expect(fileRefDe({ files: [{ "@id": "/files/abc", resource: "/tax-returns/x" }] })).toBe("/files/abc");
    expect(fileRefDe({ files: [{ resource: "/files/def/download" }] })).toBe("/files/def/download");
    expect(fileRefDe({ files: [{ id: "ghi" }] })).toBe("/files/ghi");
  });
  it("accepts a string file or a single (non-array) file", () => {
    expect(fileRefDe({ files: "/files/jkl" })).toBe("/files/jkl");
    expect(fileRefDe({ files: { "@id": "/files/mno" } })).toBe("/files/mno");
  });
  it("returns null when there is no file", () => {
    expect(fileRefDe({})).toBeNull();
    expect(fileRefDe({ files: [] })).toBeNull();
    expect(fileRefDe({ files: [{}] })).toBeNull();
  });

  // Formas reales de Syntage: cada tax-return trae hasta 3 archivos
  // (transcript PDF, ack_receipt PDF, financial_statements XLSX) en ORDEN
  // VARIABLE. Caso real: la anual 2025 de SMP traía el ack_receipt primero y
  // se descargó el acuse corto sin la tabla de pérdidas.
  it("prefiere el transcript aunque el ack_receipt venga primero (anual 2025 real)", () => {
    const files = [
      { "@id": "/files/receipt", type: "tax_return.ack_receipt", mimeType: "application/pdf" },
      { "@id": "/files/xlsx", type: "tax_return.financial_statements", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      { "@id": "/files/transcript", type: "tax_return.transcript", mimeType: "application/pdf" },
    ];
    expect(fileRefDe({ files })).toBe("/files/transcript");
  });
  it("sin transcript cae al PDF que no sea estados financieros", () => {
    const files = [
      { "@id": "/files/xlsx", type: "tax_return.financial_statements", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      { "@id": "/files/receipt", type: "tax_return.ack_receipt", mimeType: "application/pdf" },
    ];
    expect(fileRefDe({ files })).toBe("/files/receipt");
  });
  it("como último recurso devuelve el primer archivo aunque no sea PDF", () => {
    const files = [
      { "@id": "/files/xlsx", type: "tax_return.financial_statements", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    ];
    expect(fileRefDe({ files })).toBe("/files/xlsx");
  });
});

describe("tiposSinDato (lo que la empresa necesitaba y el acuse no trae)", () => {
  it("devuelve sólo los tipos necesitados sin importe — el caso IEPS que se re-pagaba cada corrida", () => {
    expect(
      tiposSinDato(
        { IVA_MENSUAL: true, ISR_PROVISIONAL: true, IEPS_MENSUAL: true },
        { IVA_MENSUAL: true, ISR_PROVISIONAL: true, IEPS_MENSUAL: false },
      ),
    ).toEqual(["IEPS_MENSUAL"]);
  });
  it("no marca lo que no se necesitaba aunque falte, ni lo que sí trae", () => {
    expect(
      tiposSinDato(
        { IVA_MENSUAL: true, ISR_PROVISIONAL: false, IEPS_MENSUAL: false },
        { IVA_MENSUAL: true, ISR_PROVISIONAL: false, IEPS_MENSUAL: false },
      ),
    ).toEqual([]);
  });
  it("con datos parciales marca cada tipo que faltó", () => {
    expect(
      tiposSinDato(
        { IVA_MENSUAL: true, ISR_PROVISIONAL: true, IEPS_MENSUAL: false },
        { IVA_MENSUAL: false, ISR_PROVISIONAL: false, IEPS_MENSUAL: false },
      ),
    ).toEqual(["IVA_MENSUAL", "ISR_PROVISIONAL"]);
  });
});
