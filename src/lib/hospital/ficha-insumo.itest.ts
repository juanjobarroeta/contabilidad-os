import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { aprobarRequisicion, crearRequisicion } from "./requisiciones";
import { comprasDeInsumo } from "./ficha-insumo";

const skip = process.env.DB_TESTS_SKIP === "1";

describe.skipIf(skip)("ficha del insumo: sus compras", () => {
  let companyId = "";
  let insumoId = "";
  let provA = "";
  let provB = "";

  beforeAll(async () => {
    companyId = (await prisma.company.create({ data: { rfc: `FIC${Date.now() % 1000000}AA1`, razonSocial: "Hospital ficha iTest", regimenFiscal: "601", codigoPostal: "72000" } })).id;
    insumoId = (await prisma.hospInsumo.create({ data: { companyId, clave: "MSI0091", nombre: "ONDANSETRON 8MG" } })).id;
    provA = (await prisma.supplier.create({ data: { companyId, rfc: "FIA010101AA1", razonSocial: "DISTRIBUIDORA A" } })).id;
    provB = (await prisma.supplier.create({ data: { companyId, rfc: "FIB010101AA1", razonSocial: "DISTRIBUIDORA B" } })).id;
  });
  afterAll(async () => {
    await prisma.hospMovimientoInsumo.deleteMany({ where: { companyId } });
    await prisma.hospLote.deleteMany({ where: { companyId } });
    await prisma.solicitudAdjudicacion.deleteMany({ where: { companyId } });
    await prisma.solicitudCotizacionPartida.deleteMany({ where: { cotizacion: { solicitud: { companyId } } } });
    await prisma.solicitudCompra.deleteMany({ where: { companyId } });
    await prisma.hospInsumo.deleteMany({ where: { companyId } });
    await prisma.supplier.deleteMany({ where: { companyId } });
    await prisma.company.delete({ where: { id: companyId } });
    await prisma.$disconnect();
  });

  it("entrada con su proveedor, requisición, quién pidió y autorizó; cotizaciones en el historial; lo que falta en camino", async () => {
    const r = await crearRequisicion(companyId, "u-compras", {
      partidas: [{ hospInsumoId: insumoId, descripcion: "ONDANSETRON 8MG", unidad: "AMP", cantidad: 36, precioUnitario: 0 }],
      cotizaciones: [{ supplierId: provA, precios: [18.5] }, { supplierId: provB, precios: [21] }],
    });
    await aprobarRequisicion(r.id, companyId, "u-director");
    const partida = await prisma.solicitudPartida.findFirstOrThrow({ where: { solicitudId: r.id } });
    const lote = await prisma.hospLote.create({ data: { companyId, insumoId, lote: "L1", existencia: 12, costoUnitario: 18.5, supplierId: provA } });
    await prisma.hospMovimientoInsumo.create({
      data: { companyId, insumoId, loteId: lote.id, tipo: "ENTRADA_COMPRA", cantidad: 12, costoUnitario: 18.5, fecha: new Date(), solicitudPartidaId: partida.id, usuarioNombre: "Almacén" },
    });
    await prisma.solicitudPartida.update({ where: { id: partida.id }, data: { cantidadRecibida: 12 } });

    const c = await comprasDeInsumo(prisma, companyId, insumoId);
    expect(c.entradas).toHaveLength(1);
    expect(c.entradas[0]).toMatchObject({ cantidad: 12, costoUnitario: 18.5, capturo: "Almacén", proveedor: { razonSocial: "DISTRIBUIDORA A" }, requisicion: { folio: r.folio } });
    expect(c.entradas[0].requisicion?.autorizadaAt).toBeTruthy();
    expect(c.enCamino).toEqual([expect.objectContaining({ cantidad: 36, recibida: 12, proveedor: expect.objectContaining({ razonSocial: "DISTRIBUIDORA A" }) })]);
    const cot = c.precios.filter((p) => p.origen === "COTIZACION").map((p) => [p.proveedor, p.precio, p.gano]);
    expect(cot).toEqual(expect.arrayContaining([["DISTRIBUIDORA A", 18.5, true], ["DISTRIBUIDORA B", 21, false]]));
    expect(c.porProveedor[0]).toMatchObject({ proveedor: "DISTRIBUIDORA A", compras: 1, cantidad: 12, ultimoCosto: 18.5, mejorCosto: 18.5 });
  });
});
