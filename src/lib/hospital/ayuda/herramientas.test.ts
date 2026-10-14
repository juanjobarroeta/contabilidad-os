import { describe, expect, it, vi } from "vitest";
import { HERRAMIENTAS, PAGINAS_HERRAMIENTA, ejecutarHerramienta, puedeUsarHerramienta } from "./herramientas";

describe("puedeUsarHerramienta", () => {
  it("sin páginas restringidas puede todo", () => {
    for (const t of HERRAMIENTAS) expect(puedeUsarHerramienta([], t.name)).toBe(true);
  });
  it("enfermería ve inventario pero no proveedores, clientes ni compras", () => {
    const p = ["censo", "episodios"];
    expect(puedeUsarHerramienta(p, "consultar_inventario")).toBe(true);
    expect(puedeUsarHerramienta(p, "insumos_por_caducar")).toBe(true);
    expect(puedeUsarHerramienta(p, "buscar_proveedores")).toBe(false);
    expect(puedeUsarHerramienta(p, "buscar_clientes")).toBe(false);
    expect(puedeUsarHerramienta(p, "compras_por_proveedor")).toBe(false);
  });
  it("caja ve clientes, no compras", () => {
    expect(puedeUsarHerramienta(["caja"], "buscar_clientes")).toBe(true);
    expect(puedeUsarHerramienta(["caja"], "compras_por_proveedor")).toBe(false);
  });
  it("compras ve inventario, proveedores y compras", () => {
    for (const n of ["consultar_inventario", "buscar_proveedores", "compras_por_proveedor"]) expect(puedeUsarHerramienta(["compras"], n)).toBe(true);
  });
  it("cada herramienta declarada tiene sus páginas", () => {
    expect(HERRAMIENTAS.map((t) => t.name).sort()).toEqual(Object.keys(PAGINAS_HERRAMIENTA).sort());
  });
});

describe("ejecutarHerramienta", () => {
  it("sin permiso no toca la base y dice qué página falta", async () => {
    const db = new Proxy({}, { get: () => { throw new Error("no debía consultar"); } }) as never;
    const r = await ejecutarHerramienta(db, { companyId: "c", paginas: ["censo"] }, "compras_por_proveedor", { desde: "2026-01-01", hasta: "2026-03-31" });
    expect(r).toMatchObject({ sinPermiso: true, requiereAlgunaDe: PAGINAS_HERRAMIENTA.compras_por_proveedor });
  });
  it("parámetros inválidos y herramientas desconocidas regresan error, no lanzan", async () => {
    const db = {} as never;
    expect(await ejecutarHerramienta(db, { companyId: "c", paginas: [] }, "compras_por_proveedor", { desde: "enero" })).toHaveProperty("error");
    expect(await ejecutarHerramienta(db, { companyId: "c", paginas: [] }, "borrar_todo", {})).toHaveProperty("error");
  });
  it("busca proveedores sólo de la empresa", async () => {
    const findMany = vi.fn(async (_args: unknown) => [{ razonSocial: "DISTRIBUIDORA A", rfc: "DIA010101AA1", email: null, terms: { tieneCredito: true, diasCredito: 30 }, _count: { solicitudesCompra: 2 } }]);
    const r = await ejecutarHerramienta({ supplier: { findMany } } as never, { companyId: "c1", paginas: ["compras"] }, "buscar_proveedores", { texto: "distribuidora" });
    expect(findMany.mock.calls[0][0]).toMatchObject({ where: { companyId: "c1" } });
    expect(r).toEqual({ proveedores: [{ razonSocial: "DISTRIBUIDORA A", rfc: "DIA010101AA1", correo: null, credito: "30 días", requisiciones: 2 }] });
  });
});
