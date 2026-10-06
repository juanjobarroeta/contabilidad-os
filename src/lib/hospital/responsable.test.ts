import { describe, expect, it } from "vitest";
import { resolverResponsable, responsablePendiente } from "./responsable";
import { fechaLocal } from "./tz";

const hoy = fechaLocal(2026, 10, 6, 12);
const adulto = fechaLocal(1990, 5, 1, 12);
const menor = fechaLocal(2015, 5, 1, 12);
const base = { nombre: " Ana ", apellidoPaterno: "López", parentesco: "Madre", telefono: "5512345678" };

describe("resolverResponsable", () => {
  it("TERCERO exige los datos del responsable y los limpia", () => {
    expect(resolverResponsable({ modo: "TERCERO", responsable: null, fechaNacimientoPaciente: menor, hoy })).toMatchObject({ ok: false, status: 400 });
    const r = resolverResponsable({ modo: "TERCERO", responsable: { ...base, email: " ", apellidoMaterno: "" }, fechaNacimientoPaciente: menor, hoy });
    expect(r).toMatchObject({ ok: true, modo: "TERCERO", responsable: { nombre: "Ana", email: null, apellidoMaterno: null, curp: null } });
  });

  it("un menor no puede ser su propio responsable", () => {
    expect(resolverResponsable({ modo: "PROPIO", responsable: null, fechaNacimientoPaciente: menor, hoy })).toMatchObject({ ok: false, error: expect.stringContaining("menor de edad") });
    expect(resolverResponsable({ modo: "PROPIO", responsable: null, fechaNacimientoPaciente: adulto, hoy })).toEqual({ ok: true, modo: "PROPIO", responsable: null });
  });

  it("PENDIENTE (urgencia) se admite sin datos, también para menores", () => {
    expect(resolverResponsable({ modo: "PENDIENTE", responsable: base, fechaNacimientoPaciente: menor, hoy })).toEqual({ ok: true, modo: "PENDIENTE", responsable: null });
  });

  it("el responsable debe ser mayor de edad (por fecha o por su CURP)", () => {
    expect(resolverResponsable({ modo: "TERCERO", responsable: base, fechaNacimientoPaciente: adulto, fechaNacimientoResponsable: menor, hoy })).toMatchObject({ ok: false, error: expect.stringContaining("mayor de edad") });
    const r = resolverResponsable({ modo: "TERCERO", responsable: { ...base, curp: "XXXX" }, fechaNacimientoPaciente: adulto, hoy });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("CURP del responsable") });
  });

  it("sin modo no toca nada (clientes anteriores)", () => {
    expect(resolverResponsable({ modo: undefined, responsable: undefined, fechaNacimientoPaciente: null, hoy })).toEqual({ ok: true, modo: null, responsable: null });
  });
});

describe("responsablePendiente", () => {
  it("PENDIENTE, o menor sin responsable registrado", () => {
    expect(responsablePendiente({ responsableModo: "PENDIENTE", fechaNacimiento: adulto }, hoy)).toBe(true);
    expect(responsablePendiente({ responsableModo: null, fechaNacimiento: menor }, hoy)).toBe(true);
    expect(responsablePendiente({ responsableModo: "TERCERO", fechaNacimiento: menor }, hoy)).toBe(false);
    expect(responsablePendiente({ responsableModo: null, fechaNacimiento: adulto }, hoy)).toBe(false);
    expect(responsablePendiente({ responsableModo: "PROPIO", fechaNacimiento: null }, hoy)).toBe(false);
  });
});
