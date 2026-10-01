import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/authz", () => ({ AuthzError: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { accesoEfectivo, leerAjustes, recalcularMiembros, SIN_AJUSTES, validarRolYPermisos } from "./puestos";

const caja = { todasLasPaginas: false, paginas: ["caja", "facturacion"], permisos: ["FINANZAS_ESCRIBIR", "CLINICA_LEER"] };

describe("accesoEfectivo", () => {
  it("el puesto define páginas y permisos", () => {
    expect(accesoEfectivo(caja, SIN_AJUSTES)).toEqual({ paginas: ["caja", "facturacion"], permisos: ["FINANZAS_ESCRIBIR", "CLINICA_LEER"] });
  });
  it("los ajustes suman y quitan sobre el puesto", () => {
    const r = accesoEfectivo(caja, { paginasExtra: ["bancos"], paginasQuitadas: ["facturacion"], permisosExtra: ["TESORERIA_PAGAR"], permisosQuitados: ["CLINICA_LEER"] });
    expect(r.paginas).toEqual(["caja", "bancos"]);
    expect(r.permisos).toEqual(["FINANZAS_ESCRIBIR", "TESORERIA_PAGAR"]);
  });
  it("todas las páginas = [] (el contrato de «ve todas»)", () => {
    expect(accesoEfectivo({ ...caja, todasLasPaginas: true }, SIN_AJUSTES).paginas).toEqual([]);
  });
  it("no se quitan páginas a un puesto que ve todas", () => {
    expect(() => accesoEfectivo({ ...caja, todasLasPaginas: true }, { ...SIN_AJUSTES, paginasQuitadas: ["nomina"] })).toThrow(/otro puesto/);
  });
  it("quedarse sin páginas se rechaza: [] significaría ver todo", () => {
    expect(() => accesoEfectivo(caja, { ...SIN_AJUSTES, paginasQuitadas: ["caja", "facturacion"] })).toThrow(/al menos una página/);
    expect(() => accesoEfectivo(null, SIN_AJUSTES)).toThrow(/al menos una página/);
  });
  it("a la medida: sin puesto, los extra son todo", () => {
    expect(accesoEfectivo(null, { ...SIN_AJUSTES, paginasExtra: ["mantenimiento"] })).toEqual({ paginas: ["mantenimiento"], permisos: [] });
  });
});

describe("reglas", () => {
  it("sólo lectura no recibe escritura", () => {
    expect(() => validarRolYPermisos("VIEWER", ["CLINICA_LEER", "FINANZAS_ESCRIBIR"])).toThrow(/Sólo lectura/);
    expect(() => validarRolYPermisos("VIEWER", ["CLINICA_LEER"])).not.toThrow();
  });
  it("ajustes guardados con basura se leen como vacíos", () => {
    expect(leerAjustes(null)).toEqual(SIN_AJUSTES);
    expect(leerAjustes({ permisosExtra: ["NO_EXISTE"] })).toEqual(SIN_AJUSTES);
  });
});

describe("recalcularMiembros", () => {
  it("cambiar el puesto recalcula a cada miembro; a sólo lectura se le filtra la escritura", async () => {
    const updates: unknown[] = [];
    const tx = {
      hospPuesto: { findUniqueOrThrow: vi.fn().mockResolvedValue({ ...caja, paginas: ["caja"] }) },
      companyMember: {
        findMany: vi.fn().mockResolvedValue([
          { id: "m1", role: "ACCOUNTANT", hospitalAjustes: { paginasExtra: ["bancos"] } },
          { id: "m2", role: "VIEWER", hospitalAjustes: null },
        ]),
        update: vi.fn(async (a: unknown) => updates.push(a)),
      },
    };
    expect(await recalcularMiembros(tx as never, "p1")).toBe(2);
    expect(updates).toEqual([
      { where: { id: "m1" }, data: { hospitalPaginas: ["caja", "bancos"], hospitalPermisos: ["FINANZAS_ESCRIBIR", "CLINICA_LEER"] } },
      { where: { id: "m2" }, data: { hospitalPaginas: ["caja"], hospitalPermisos: ["CLINICA_LEER"] } },
    ]);
  });
});
