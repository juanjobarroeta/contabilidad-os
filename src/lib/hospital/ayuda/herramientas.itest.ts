import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { ejecutarHerramienta } from "./herramientas";

const skip = process.env.DB_TESTS_SKIP === "1";

describe.skipIf(skip)("herramientas de la mascota (consultas reales)", () => {
  let companyId = "";
  const ctx = () => ({ companyId, paginas: [] as string[] });

  beforeAll(async () => {
    companyId = (await prisma.company.create({ data: { rfc: `MOC${Date.now() % 1000000}AA1`, razonSocial: "Hospital mochi iTest", regimenFiscal: "601", codigoPostal: "72000" } })).id;
    const prov = (await prisma.supplier.create({ data: { companyId, rfc: "MOA010101AA1", razonSocial: "DISTRIBUIDORA MOCHI" } })).id;
    const insumo = (await prisma.hospInsumo.create({ data: { companyId, clave: "MSI0091", nombre: "ONDANSETRON 8MG", minimo: 20 } })).id;
    const pronto = new Date(Date.now() + 20 * 86_400_000);
    const lote = await prisma.hospLote.create({ data: { companyId, insumoId: insumo, lote: "L1", existencia: 12, costoUnitario: 18.5, caducidad: pronto, supplierId: prov } });
    await prisma.hospLote.create({ data: { companyId, insumoId: insumo, lote: "L2", existencia: 0, costoUnitario: 18.5 } });
    await prisma.hospMovimientoInsumo.create({ data: { companyId, insumoId: insumo, loteId: lote.id, tipo: "ENTRADA_COMPRA", cantidad: 12, costoUnitario: 18.5, fecha: new Date("2026-02-10T12:00:00") } });
    const factura = (n: string, total: number, extra: Record<string, unknown> = {}) =>
      prisma.invoice.create({ data: { companyId, uuid: `${companyId}-${n}`, tipo: "EGRESO", status: "STAMPED", fecha: new Date("2026-02-10T12:00:00"), contraparteRfc: "MOA010101AA1", contraparteNombre: "DISTRIBUIDORA MOCHI", subtotal: total, total, formaPago: "03", metodoPago: "PPD", usoCfdi: "G01", moneda: "MXN", ...extra } });
    await factura("f1", 1000);
    await factura("f2", 500);
    await factura("f3", 999, { status: "CANCELLED" });
    await factura("f4", 777, { fecha: new Date("2025-12-31T12:00:00") });
  });
  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { companyId } });
    await prisma.hospMovimientoInsumo.deleteMany({ where: { companyId } });
    await prisma.hospLote.deleteMany({ where: { companyId } });
    await prisma.hospInsumo.deleteMany({ where: { companyId } });
    await prisma.supplier.deleteMany({ where: { companyId } });
    await prisma.company.delete({ where: { id: companyId } });
    await prisma.$disconnect();
  });

  it("existencia con lotes, caducidad y proveedor", async () => {
    const r = (await ejecutarHerramienta(prisma, ctx(), "consultar_inventario", { texto: "ondansetron 8" })) as { insumos: Array<Record<string, unknown>> };
    expect(r.insumos).toHaveLength(1);
    expect(r.insumos[0]).toMatchObject({ clave: "MSI0091", existencia: 12, minimo: 20, bajoMinimo: true });
    expect(r.insumos[0].lotes).toEqual([expect.objectContaining({ lote: "L1", existencia: 12, proveedor: "DISTRIBUIDORA MOCHI", caducado: false })]);
    const porClave = (await ejecutarHerramienta(prisma, ctx(), "consultar_inventario", { texto: "msi0091" })) as { encontrados: number };
    expect(porClave.encontrados).toBe(1);
  });

  it("lotes por caducar dentro de la ventana", async () => {
    const r = (await ejecutarHerramienta(prisma, ctx(), "insumos_por_caducar", { dias: 30 })) as { lotes: Array<Record<string, unknown>> };
    expect(r.lotes).toEqual([expect.objectContaining({ lote: "L1", nombre: "ONDANSETRON 8MG" })]);
    const corto = (await ejecutarHerramienta(prisma, ctx(), "insumos_por_caducar", { dias: 5 })) as { lotes: unknown[] };
    expect(corto.lotes).toHaveLength(0);
  });

  it("compras a un proveedor en el periodo: sin canceladas ni fuera de fecha", async () => {
    const r = (await ejecutarHerramienta(prisma, ctx(), "compras_por_proveedor", { proveedor: "mochi", desde: "2026-01-01", hasta: "2026-03-31" })) as {
      facturasRecibidas: { total: number; porProveedor: Array<Record<string, unknown>> };
      insumosRecibidos: Array<Record<string, unknown>>;
    };
    expect(r.facturasRecibidas.total).toBe(1500);
    expect(r.facturasRecibidas.porProveedor[0]).toMatchObject({ facturas: 2, totalConIva: 1500 });
    expect(r.insumosRecibidos[0]).toMatchObject({ clave: "MSI0091", cantidad: 12, monto: 222, proveedor: "DISTRIBUIDORA MOCHI" });
  });

  it("no ve datos de otra empresa", async () => {
    const r = (await ejecutarHerramienta(prisma, { companyId: "otra", paginas: [] }, "consultar_inventario", { texto: "ondansetron" })) as { encontrados: number };
    expect(r.encontrados).toBe(0);
  });
});
