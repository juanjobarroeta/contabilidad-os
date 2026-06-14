import { describe, it, expect } from "vitest";
import { mesDePeriodo, fileRefDe } from "./declaraciones-backfill";

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
});
