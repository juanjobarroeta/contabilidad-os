import { describe, expect, it, vi } from "vitest";

// rol.ts importa AuthzError desde ../authz, que arrastra NextAuth y prisma;
// para probar la tabla de reglas (pura) los sustituimos por stubs.
vi.mock("../auth", () => ({ auth: vi.fn() }));
vi.mock("../prisma", () => ({ prisma: {} }));

import { enforceConstruccionRol } from "./rol";

const req = (method: string, path: string) =>
  new Request(`https://x.test${path}`, { method });

const allowed = (rol: "TESORERIA" | "RESIDENTE", method: string, path: string) => {
  try {
    enforceConstruccionRol(rol, req(method, path));
    return true;
  } catch {
    return false;
  }
};

describe("enforceConstruccionRol", () => {
  it("tesorería: ve y paga su cola, nada más", () => {
    expect(allowed("TESORERIA", "GET", "/api/construccion/adjudicaciones")).toBe(true);
    expect(allowed("TESORERIA", "POST", "/api/construccion/pagos-proveedor")).toBe(true);
    expect(allowed("TESORERIA", "POST", "/api/construccion/solicitudes-compra/abc/pagar")).toBe(true);
    expect(allowed("TESORERIA", "POST", "/api/construccion/solicitudes-compra/abc/vincular-bt")).toBe(true);
    // decisiones y otros módulos: no
    expect(allowed("TESORERIA", "POST", "/api/construccion/solicitudes-compra")).toBe(false);
    expect(allowed("TESORERIA", "POST", "/api/construccion/solicitudes-compra/abc/aprobar")).toBe(false);
    expect(allowed("TESORERIA", "GET", "/api/construccion/presupuestos")).toBe(false);
    expect(allowed("TESORERIA", "GET", "/api/construccion/reembolsos")).toBe(false);
    expect(allowed("TESORERIA", "POST", "/api/construccion/proyectos")).toBe(false);
    expect(allowed("TESORERIA", "GET", "/api/construccion/usuarios")).toBe(false);
  });

  it("residente: requisiciones sí, decisiones no; presupuesto sólo lectura", () => {
    expect(allowed("RESIDENTE", "POST", "/api/construccion/solicitudes-compra")).toBe(true);
    expect(allowed("RESIDENTE", "PATCH", "/api/construccion/solicitudes-compra/abc")).toBe(true);
    expect(allowed("RESIDENTE", "GET", "/api/construccion/presupuestos/abc")).toBe(true);
    expect(allowed("RESIDENTE", "GET", "/api/construccion/apus/abc")).toBe(true);
    expect(allowed("RESIDENTE", "GET", "/api/construccion/reembolsos")).toBe(true);
    // escritura de presupuesto/APU y decisiones de compra: no
    expect(allowed("RESIDENTE", "POST", "/api/construccion/presupuestos")).toBe(false);
    expect(allowed("RESIDENTE", "PATCH", "/api/construccion/apus/abc")).toBe(false);
    expect(allowed("RESIDENTE", "POST", "/api/construccion/solicitudes-compra/abc/aprobar")).toBe(false);
    expect(allowed("RESIDENTE", "POST", "/api/construccion/solicitudes-compra/abc/cotizaciones")).toBe(false);
    expect(allowed("RESIDENTE", "POST", "/api/construccion/solicitudes-compra/abc/pagar")).toBe(false);
    expect(allowed("RESIDENTE", "POST", "/api/construccion/reembolsos")).toBe(false);
    expect(allowed("RESIDENTE", "GET", "/api/construccion/bank-transactions")).toBe(false);
    expect(allowed("RESIDENTE", "GET", "/api/construccion/usuarios")).toBe(false);
  });

  it("fuera de /api/construccion no restringe (p. ej. cambiar contraseña)", () => {
    expect(allowed("RESIDENTE", "POST", "/api/auth/change-password")).toBe(true);
    expect(allowed("TESORERIA", "POST", "/api/auth/change-password")).toBe(true);
  });
});
