import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { citaCamposSchema, datosHojaCita, puedeProgramarAgenda } from "./citas";

describe("datosHojaCita", () => {
  it("only touches the keys that came (PATCH)", () => {
    expect(datosHojaCita({ enfermera: "  Julia Trejo " })).toEqual({ enfermera: "Julia Trejo" });
    expect(datosHojaCita({})).toEqual({});
  });
  it("a new anesthesiologist goes back to «por confirmar»", () => {
    expect(datosHojaCita({ anestesiologoId: "b" }, { anestesiologoId: "a" })).toEqual({ anestesiologoId: "b", anestesiologoConfirmado: false });
    expect(datosHojaCita({ anestesiologoId: "a" }, { anestesiologoId: "a" })).toEqual({ anestesiologoId: "a" });
    expect(datosHojaCita({ anestesiologoId: "b", anestesiologoConfirmado: true }, { anestesiologoId: "a" })).toEqual({ anestesiologoId: "b", anestesiologoConfirmado: true });
    expect(datosHojaCita({ anestesiologoId: null, anestesiologoConfirmado: true }, { anestesiologoId: "a" })).toEqual({ anestesiologoId: null, anestesiologoConfirmado: false });
    expect(datosHojaCita({ anestesiologoConfirmado: true })).toEqual({ anestesiologoConfirmado: true });
  });
  it("empty supplies clear the column", () => {
    expect(datosHojaCita({ insumos: [] }).insumos).toBe(Prisma.DbNull);
    const insumos = [{ descripcion: "Monocryl 1-0", cantidad: 2, origen: "HOSPITAL" as const }];
    expect(datosHojaCita({ insumos }).insumos).toEqual(insumos);
  });
});

describe("citaCamposSchema (hoja)", () => {
  const base = { recursoId: "q1", tipo: "CIRUGIA", titulo: "Rinoseptoplastia", inicio: "2026-10-09T16:00:00.000Z", fin: "2026-10-09T18:00:00.000Z" };
  it("supplies default to the hospital and reject unknown origins", () => {
    const r = citaCamposSchema.parse({ ...base, insumos: [{ descripcion: "Manipulador uterino" }] });
    expect(r.insumos?.[0].origen).toBe("HOSPITAL");
    expect(citaCamposSchema.safeParse({ ...base, insumos: [{ descripcion: "x", origen: "OTRO" }] }).success).toBe(false);
  });
  it("anesthesia type is the SAEH 1–6 code", () => {
    expect(citaCamposSchema.safeParse({ ...base, tipoAnestesia: 3 }).success).toBe(true);
    expect(citaCamposSchema.safeParse({ ...base, tipoAnestesia: 7 }).success).toBe(false);
  });
});

describe("puedeProgramarAgenda", () => {
  it("needs a writer role and AGENDA_PROGRAMAR", () => {
    expect(puedeProgramarAgenda("ACCOUNTANT", ["CLINICA_LEER", "AGENDA_PROGRAMAR"])).toBe(true);
    expect(puedeProgramarAgenda("ACCOUNTANT", ["CLINICA_LEER", "CLINICA_ESCRIBIR"])).toBe(false);
    expect(puedeProgramarAgenda("VIEWER", ["AGENDA_PROGRAMAR"])).toBe(false);
    expect(puedeProgramarAgenda("OWNER", null)).toBe(false);
  });
});
