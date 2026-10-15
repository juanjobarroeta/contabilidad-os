import { describe, expect, it, vi } from "vitest";
import { completarProveedor, completarSchema } from "./proveedores";

function db({ existe = true, clabeLibre = true, sinTerminos = true } = {}) {
  const updateMany = vi.fn(async () => ({ count: clabeLibre ? 1 : 0 }));
  const createMany = vi.fn(async () => ({ count: sinTerminos ? 1 : 0 }));
  const tx = { supplier: { updateMany }, supplierTerms: { createMany } };
  return {
    updateMany, createMany,
    db: { supplier: { count: vi.fn(async () => (existe ? 1 : 0)) }, $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } as never,
  };
}

describe("completarProveedor (sólo llena lo que falta)", () => {
  it("guarda la cuenta sólo donde no hay CLABE, en la misma sentencia", async () => {
    const m = db();
    const r = await completarProveedor(m.db, "c1", "s1", { clabe: "012180001234567891", banco: "BBVA" });
    expect(r).toEqual({ guardados: ["cuenta"], omitidos: [] });
    expect(m.updateMany).toHaveBeenCalledWith({ where: { id: "s1", clabe: null }, data: { clabe: "012180001234567891", banco: "BBVA" } });
  });
  it("no sobrescribe una CLABE ni un crédito ya registrados", async () => {
    const m = db({ clabeLibre: false, sinTerminos: false });
    const r = await completarProveedor(m.db, "c1", "s1", { clabe: "012180001234567891", tieneCredito: true, diasCredito: 30 });
    expect(r).toEqual({ guardados: [], omitidos: ["cuenta", "credito"] });
  });
  it("crédito nuevo: crea las condiciones sin duplicar", async () => {
    const m = db();
    const r = await completarProveedor(m.db, "c1", "s1", { tieneCredito: true, diasCredito: 45 });
    expect(r?.guardados).toEqual(["credito"]);
    expect(m.createMany).toHaveBeenCalledWith({ data: [{ supplierId: "s1", tieneCredito: true, diasCredito: 45 }], skipDuplicates: true });
  });
  it("banco sin CLABE no se guarda; proveedor ajeno es null", async () => {
    const m = db();
    expect(await completarProveedor(m.db, "c1", "s1", { banco: "BBVA" })).toEqual({ guardados: [], omitidos: ["cuenta"] });
    expect(m.updateMany).not.toHaveBeenCalled();
    expect(await completarProveedor(db({ existe: false }).db, "c1", "s1", { clabe: "012180001234567891" })).toBeNull();
  });
  it("valida la CLABE", () => {
    expect(completarSchema.safeParse({ clabe: "123" }).success).toBe(false);
  });
});
