import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { citaCamposSchema, citaEmpalmada, datosHojaCita, describirEmpalme, ocupaRecurso, puedeProgramarAgenda } from "./citas";

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

describe("solicitudes y limpieza", () => {
  it("a request, a cancellation or a no-show does not hold the room", () => {
    expect(ocupaRecurso("SOLICITADA")).toBe(false);
    expect(ocupaRecurso("CANCELADA")).toBe(false);
    expect(ocupaRecurso("NO_ASISTIO")).toBe(false);
    expect(ocupaRecurso("PROGRAMADA")).toBe(true);
  });

  const h = (hh: number, mm = 0) => new Date(Date.UTC(2026, 9, 9, hh, mm));
  const fakeDb = (limpieza: number, citas: Array<{ inicio: Date; fin: Date }>) => ({
    hospRecurso: { findUnique: async () => ({ minutosLimpieza: limpieza }) },
    hospCita: {
      findFirst: async ({ where }: { where: { inicio: { lt: Date }; fin: { gt: Date } } }) => {
        const c = citas.find((x) => x.inicio < where.inicio.lt && x.fin > where.fin.gt);
        return c ? { id: "x", titulo: "Rinoseptoplastia", pacienteNombre: null, recurso: { nombre: "Quirófano 1" }, ...c } : null;
      },
    },
  });

  it("the cleaning gap blocks a case that starts right after another", async () => {
    const db = fakeDb(30, [{ inicio: h(16), fin: h(18) }]) as never;
    const choque = await citaEmpalmada(db, { recursoId: "q1", inicio: h(18, 15), fin: h(19) });
    expect(choque?.limpieza).toBe(30);
    expect(describirEmpalme(choque!)).toMatch(/necesita 30 min de limpieza/);
    expect(await citaEmpalmada(db, { recursoId: "q1", inicio: h(18, 30), fin: h(19) })).toBeNull();
    expect(await citaEmpalmada(db, { recursoId: "q1", inicio: h(15), fin: h(15, 30) })).toBeNull();
  });

  it("a real overlap is reported without the cleaning note", async () => {
    const db = fakeDb(30, [{ inicio: h(16), fin: h(18) }]) as never;
    const choque = await citaEmpalmada(db, { recursoId: "q1", inicio: h(17), fin: h(19) });
    expect(choque?.limpieza).toBe(0);
    expect(describirEmpalme(choque!)).not.toMatch(/limpieza/);
  });

  it("without cleaning minutes back-to-back cases are fine", async () => {
    const db = fakeDb(0, [{ inicio: h(16), fin: h(18) }]) as never;
    expect(await citaEmpalmada(db, { recursoId: "q1", inicio: h(18), fin: h(19) })).toBeNull();
  });
});
