import { describe, expect, it, vi } from "vitest";

// rol.ts importa AuthzError desde ../authz, que arrastra NextAuth y prisma;
// para probar la tabla de reglas (pura) los sustituimos por stubs.
vi.mock("../auth", () => ({ auth: vi.fn() }));
vi.mock("../prisma", () => ({ prisma: {} }));

import { enforceConstruccionRol } from "./rol";

const req = (method: string, path: string) =>
  new Request(`https://x.test${path}`, { method });

const allowed = (
  rol: "TESORERIA" | "RESIDENTE" | "CONTABILIDAD",
  method: string,
  path: string,
  paginas: string[] = []
) => {
  try {
    enforceConstruccionRol(rol, req(method, path), paginas);
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
    expect(allowed("TESORERIA", "POST", "/api/construccion/gastos/abc/aprobar-pagar")).toBe(true);
    expect(allowed("TESORERIA", "POST", "/api/construccion/gastos")).toBe(false);
    expect(allowed("TESORERIA", "POST", "/api/construccion/gastos/abc/aprobar")).toBe(false);
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
    // Proveedores: ver y dar de alta; editar existentes/importar de CFDIs no
    expect(allowed("RESIDENTE", "POST", "/api/construccion/suppliers")).toBe(true);
    expect(allowed("RESIDENTE", "GET", "/api/construccion/suppliers/abc")).toBe(true);
    expect(allowed("RESIDENTE", "PATCH", "/api/construccion/suppliers/abc")).toBe(false);
    expect(allowed("RESIDENTE", "POST", "/api/construccion/suppliers/import-cfdis")).toBe(false);
    // Caja chica: captura gastos con comprobante, sin decidir sobre ellos
    expect(allowed("RESIDENTE", "POST", "/api/construccion/gastos")).toBe(true);
    expect(allowed("RESIDENTE", "PATCH", "/api/construccion/gastos/abc")).toBe(true);
    expect(allowed("RESIDENTE", "GET", "/api/construccion/gastos/abc/comprobante")).toBe(true);
    expect(allowed("RESIDENTE", "POST", "/api/construccion/gastos/abc/aprobar")).toBe(false);
    expect(allowed("RESIDENTE", "POST", "/api/construccion/gastos/abc/aprobar-pagar")).toBe(false);
    expect(allowed("RESIDENTE", "POST", "/api/construccion/gastos/abc/enviar-tesoreria")).toBe(false);
    // escritura de presupuesto/APU y decisiones de compra: no
    expect(allowed("RESIDENTE", "POST", "/api/construccion/presupuestos")).toBe(false);
    expect(allowed("RESIDENTE", "PATCH", "/api/construccion/apus/abc")).toBe(false);
    expect(allowed("RESIDENTE", "POST", "/api/construccion/solicitudes-compra/abc/aprobar")).toBe(false);
    expect(allowed("RESIDENTE", "POST", "/api/construccion/solicitudes-compra/abc/cotizaciones")).toBe(false);
    expect(allowed("RESIDENTE", "POST", "/api/construccion/solicitudes-compra/abc/pagar")).toBe(false);
    expect(allowed("RESIDENTE", "GET", "/api/construccion/bank-transactions")).toBe(false);
    expect(allowed("RESIDENTE", "GET", "/api/construccion/usuarios")).toBe(false);
  });

  it("contabilidad: proveedores/compras/pagos sí, presupuesto lectura, lo demás no", () => {
    expect(allowed("CONTABILIDAD", "POST", "/api/construccion/suppliers")).toBe(true);
    expect(allowed("CONTABILIDAD", "PATCH", "/api/construccion/suppliers/abc")).toBe(true);
    expect(allowed("CONTABILIDAD", "PUT", "/api/construccion/suppliers/abc/terms")).toBe(true);
    expect(allowed("CONTABILIDAD", "POST", "/api/construccion/solicitudes-compra/abc/aprobar")).toBe(true);
    expect(allowed("CONTABILIDAD", "POST", "/api/construccion/solicitudes-compra/abc/adjudicaciones")).toBe(true);
    expect(allowed("CONTABILIDAD", "POST", "/api/construccion/solicitudes-compra/abc/cotizaciones")).toBe(true);
    expect(allowed("CONTABILIDAD", "POST", "/api/construccion/pagos-proveedor")).toBe(true);
    expect(allowed("CONTABILIDAD", "POST", "/api/construccion/gastos/abc/enviar-tesoreria")).toBe(true);
    expect(allowed("CONTABILIDAD", "GET", "/api/construccion/presupuestos/abc")).toBe(true);
    // Lo que NO: crear requisiciones/obras, escribir presupuesto, admin
    expect(allowed("CONTABILIDAD", "POST", "/api/construccion/solicitudes-compra")).toBe(false);
    expect(allowed("CONTABILIDAD", "POST", "/api/construccion/presupuestos")).toBe(false);
    expect(allowed("CONTABILIDAD", "POST", "/api/construccion/proyectos")).toBe(false);
    expect(allowed("CONTABILIDAD", "GET", "/api/construccion/reembolsos")).toBe(false);
    expect(allowed("CONTABILIDAD", "GET", "/api/construccion/usuarios")).toBe(false);
  });

  it("push: todos los roles pueden suscribirse a sus notificaciones", () => {
    for (const rol of ["TESORERIA", "RESIDENTE", "CONTABILIDAD"] as const) {
      expect(allowed(rol, "GET", "/api/construccion/push")).toBe(true);
      expect(allowed(rol, "POST", "/api/construccion/push")).toBe(true);
      expect(allowed(rol, "DELETE", "/api/construccion/push")).toBe(true);
    }
  });

  it("grants de la matriz: una página extra amplía con su bundle", () => {
    // Residente con Compras marcada: puede autorizar/cotizar (el bundle)
    expect(allowed("RESIDENTE", "POST", "/api/construccion/solicitudes-compra/abc/aprobar", ["compras"])).toBe(true);
    expect(allowed("RESIDENTE", "POST", "/api/construccion/solicitudes-compra/abc/cotizaciones", ["compras"])).toBe(true);
    // Sin la marca, sigue bloqueado
    expect(allowed("RESIDENTE", "POST", "/api/construccion/solicitudes-compra/abc/aprobar")).toBe(false);
    // Tesorería con Facturas marcada: lee CFDIs y vincula
    expect(allowed("TESORERIA", "GET", "/api/construccion/cfdis", ["facturas"])).toBe(true);
    expect(allowed("TESORERIA", "POST", "/api/construccion/cfdis/abc/vincular", ["facturas"])).toBe(true);
    // Contabilidad con Bancos marcada: concilia
    expect(allowed("CONTABILIDAD", "POST", "/api/construccion/bank-transactions/abc/conciliar", ["bancos"])).toBe(true);
    expect(allowed("CONTABILIDAD", "POST", "/api/construccion/bank-transactions/abc/conciliar")).toBe(false);
  });

  it("grants: una página DENTRO del alcance del rol no amplía facultades", () => {
    // Caja chica es natural del residente: abre y edita SUS cajas (el candado
    // de dueño vive en la ruta), pero cerrarlas (reembolsar) sigue fuera
    // aunque la marque en la matriz — el bundle no aplica dentro del alcance.
    expect(allowed("RESIDENTE", "POST", "/api/construccion/reembolsos")).toBe(true);
    expect(allowed("RESIDENTE", "POST", "/api/construccion/reembolsos/abc/gastos")).toBe(true);
    expect(allowed("RESIDENTE", "POST", "/api/construccion/reembolsos/abc/reembolsar", ["caja"])).toBe(false);
    // Y gastos (también natural): las decisiones siguen fuera
    expect(allowed("RESIDENTE", "POST", "/api/construccion/gastos/abc/aprobar", ["gastos", "caja"])).toBe(false);
    // usuarios nunca es grantable por bundle
    expect(allowed("RESIDENTE", "GET", "/api/construccion/usuarios", ["usuarios"])).toBe(false);
  });

  it("fuera de /api/construccion no restringe (p. ej. cambiar contraseña)", () => {
    expect(allowed("RESIDENTE", "POST", "/api/auth/change-password")).toBe(true);
    expect(allowed("TESORERIA", "POST", "/api/auth/change-password")).toBe(true);
  });
});
