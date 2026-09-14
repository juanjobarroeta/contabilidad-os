import { describe, expect, it } from "vitest";
import { PERMISOS, ROLES, esRol, puede } from "./despacho";

describe("papeles del despacho", () => {
  it("sólo el socio administra; el administrativo no redacta ni cierra", () => {
    expect(puede("socio", "administrarDespacho")).toBe(true);
    for (const r of ["abogado", "pasante", "administrativo"] as const) expect(puede(r, "administrarDespacho")).toBe(false);
    expect(puede("pasante", "redactar")).toBe(true);
    expect(puede("pasante", "cerrarCaso")).toBe(false);
    expect(puede("pasante", "borrar")).toBe(false);
    expect(puede("administrativo", "redactar")).toBe(false);
    expect(puede("administrativo", "ver")).toBe(true);
    expect(puede("abogado", "cerrarCaso")).toBe(true);
  });

  it("sin despacho, alguien sigue pudiendo trabajar lo suyo pero no administra", () => {
    expect(puede(null, "trabajarCaso")).toBe(true);
    expect(puede(null, "redactar")).toBe(true);
    expect(puede(null, "administrarDespacho")).toBe(false);
    expect(puede(null, "cerrarCaso")).toBe(false);
  });

  it("todos los papeles ven, y esRol rechaza lo inventado", () => {
    for (const r of ROLES) expect(puede(r, "ver")).toBe(true);
    expect(PERMISOS.ver).toEqual(ROLES);
    expect(esRol("socio")).toBe(true);
    expect(esRol("jefe")).toBe(false);
    expect(esRol(null)).toBe(false);
  });
});

describe("errores de negocio con su status", () => {
  it("dejar al despacho sin socio es 409, no 401", async () => {
    const { ErrorJuridico, conflicto, noEncontrado, prohibido } = await import("./errores-api");
    expect(conflicto("x")).toBeInstanceOf(ErrorJuridico);
    expect(conflicto("x").status).toBe(409);
    expect(noEncontrado("Miembro").status).toBe(404);
    expect(noEncontrado("Miembro").message).toBe("Miembro no encontrado");
    expect(prohibido("no eres socio").status).toBe(403);
    expect(new ErrorJuridico("falta el nombre").status).toBe(400);
  });
});
