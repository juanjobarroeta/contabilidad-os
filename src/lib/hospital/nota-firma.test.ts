import { describe, expect, it } from "vitest";
import { hashFirmaNota, motivoNoFirmable, verificarFirmaNota } from "./nota-firma";
import { esIdentificacionDeResponsable } from "./admision";

const base = { id: "n1", autorUserId: "u1", hash: "abc", firmadaAt: null, tipo: "INGRESO" as const, reemplazadaPor: null, hashVerificado: true };

describe("motivoNoFirmable", () => {
  it("el autor firma su nota sellada y vigente", () => {
    expect(motivoNoFirmable(base, "u1")).toBeNull();
  });
  it("otro usuario no", () => {
    expect(motivoNoFirmable(base, "u2")).toMatch(/Sólo quien escribió/);
    expect(motivoNoFirmable({ ...base, autorUserId: null }, "u1")).toMatch(/Sólo quien escribió/);
  });
  it("ni firmada, ni sustituida, ni sin sello, ni con sello roto", () => {
    expect(motivoNoFirmable({ ...base, firmadaAt: new Date() }, "u1")).toMatch(/ya está firmada/);
    expect(motivoNoFirmable({ ...base, reemplazadaPor: { id: "n2" } }, "u1")).toMatch(/sustituida/);
    expect(motivoNoFirmable({ ...base, hash: null }, "u1")).toMatch(/sello/);
    expect(motivoNoFirmable({ ...base, hashVerificado: false }, "u1")).toMatch(/no coincide/);
    expect(motivoNoFirmable({ ...base, tipo: "MEDICAMENTO_APLICADO" }, "u1")).toMatch(/sistema/);
  });
});

describe("verificarFirmaNota", () => {
  const at = new Date("2026-10-08T12:00:00Z");
  const imagen = "data:image/png;base64,iVBORw0KGgo=";
  const firmaHash = hashFirmaNota({ imagen, hashNota: "abc", autorNombre: "Dra. Pérez", at });
  it("coincide con el trazo, la nota y la fecha", () => {
    expect(verificarFirmaNota({ firmaImagen: imagen, firmaHash, firmadaAt: at, hash: "abc", autorNombre: "Dra. Pérez" })).toBe(true);
  });
  it("se rompe si cambia la nota o el trazo", () => {
    expect(verificarFirmaNota({ firmaImagen: imagen, firmaHash, firmadaAt: at, hash: "otro", autorNombre: "Dra. Pérez" })).toBe(false);
    expect(verificarFirmaNota({ firmaImagen: imagen + "A", firmaHash, firmadaAt: at, hash: "abc", autorNombre: "Dra. Pérez" })).toBe(false);
  });
  it("sin firma es null", () => {
    expect(verificarFirmaNota({ firmaImagen: null, firmaHash: null, firmadaAt: null, hash: "abc", autorNombre: "x" })).toBeNull();
  });
});

describe("esIdentificacionDeResponsable", () => {
  it("distingue la del responsable de la del paciente", () => {
    expect(esIdentificacionDeResponsable({ titular: "RESPONSABLE", tipo: "INE" })).toBe(true);
    expect(esIdentificacionDeResponsable({ tipo: "INE" })).toBe(false);
    expect(esIdentificacionDeResponsable(null)).toBe(false);
  });
});
