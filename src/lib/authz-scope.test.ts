import { describe, it, expect, vi } from "vitest";

// authz.ts importa NextAuth (./auth) y prisma; para probar requireScope (que
// es pura) los sustituimos por stubs vacíos.
vi.mock("./auth", () => ({ auth: vi.fn() }));
vi.mock("./prisma", () => ({ prisma: {} }));

import { requireScope, AuthzError, type AuthUser } from "./authz";

const base: AuthUser = { id: "u1", email: "a@b.mx", name: "A" };

describe("requireScope — enforcement suave por satélite", () => {
  it("token SIN scope = acceso total (sesión web, tokens legados)", () => {
    expect(() => requireScope(base, "facturas")).not.toThrow();
    expect(() => requireScope({ ...base, scope: undefined }, "nomina")).not.toThrow();
  });

  it("token con el scope requerido pasa", () => {
    const user = { ...base, scope: "clientes facturas nomina" };
    expect(() => requireScope(user, "clientes")).not.toThrow();
    expect(() => requireScope(user, "facturas")).not.toThrow();
    expect(() => requireScope(user, "nomina")).not.toThrow();
  });

  it("token con scope pero SIN el requerido lanza AuthzError 403", () => {
    const user = { ...base, scope: "clientes" };
    try {
      requireScope(user, "nomina");
      expect.unreachable("debió lanzar");
    } catch (e) {
      expect(e).toBeInstanceOf(AuthzError);
      expect((e as AuthzError).status).toBe(403);
      expect((e as AuthzError).message).toContain("nomina");
    }
  });

  it("no hay coincidencias parciales: 'facturas' no habilita 'factura' ni viceversa", () => {
    expect(() => requireScope({ ...base, scope: "facturas" }, "factura")).toThrow(AuthzError);
    expect(() => requireScope({ ...base, scope: "factura" }, "facturas")).toThrow(AuthzError);
  });

  it("tolera espacios múltiples en el claim", () => {
    const user = { ...base, scope: "  clientes   nomina " };
    expect(() => requireScope(user, "nomina")).not.toThrow();
    expect(() => requireScope(user, "facturas")).toThrow(AuthzError);
  });
});
