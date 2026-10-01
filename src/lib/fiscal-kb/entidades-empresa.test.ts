import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { combinarEntidades } from "./entidades-empresa";

describe("combinarEntidades", () => {
  it("domicilio por CP primero, luego los estados de nómina (sucursales), sin repetir", () => {
    expect(combinarEntidades("72000", ["JAL", "PUE", "nle", "jal"])).toEqual({ domicilio: "PUE", todas: ["PUE", "JAL", "NLE"] });
  });

  it("ignora claves que no son entidad y CP inválido", () => {
    expect(combinarEntidades("abc", ["XX", "", "CMX"])).toEqual({ domicilio: null, todas: ["CMX"] });
  });

  it("CDMX por CP 0xxxx", () => {
    expect(combinarEntidades("06600", []).todas).toEqual(["CMX"]);
  });
});
