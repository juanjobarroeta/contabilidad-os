import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { idsProveedoresQueCoinciden } from "./proveedores-buscar";

const skip = process.env.DB_TESTS_SKIP === "1";

describe.skipIf(skip)("proveedores: búsqueda sin acentos y alta desde CFDIs recibidos", () => {
  let companyId = "";
  let previo = "";

  beforeAll(async () => {
    const c = await prisma.company.create({
      data: { rfc: `PBU${Date.now() % 1000000}AA1`, razonSocial: "Hospital iTest", regimenFiscal: "601", codigoPostal: "72000" },
    });
    companyId = c.id;
    previo = (await prisma.supplier.create({ data: { companyId, rfc: "DME010101AA1", razonSocial: "DISTRIBUIDORA MÉDICA DEL SUR SA DE CV" } })).id;
    const base = { companyId, tipo: "EGRESO" as const, fecha: new Date("2026-10-01"), formaPago: "03", metodoPago: "PUE", usoCfdi: "G03", subtotal: 100, total: 116, moneda: "MXN" };
    await prisma.invoice.createMany({
      data: [
        { ...base, uuid: `${companyId}-1`, status: "STAMPED", contraparteRfc: "EUR020202BB2", contraparteNombre: "EUROWIPE SA DE CV" },
        { ...base, uuid: `${companyId}-2`, status: "CANCELLED", contraparteRfc: "CAN030303CC3", contraparteNombre: "EUROPA CANCELADA SA" },
      ],
    });
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { companyId } });
    await prisma.supplier.deleteMany({ where: { companyId } });
    await prisma.company.delete({ where: { id: companyId } });
    await prisma.$disconnect();
  });

  it("encuentra sin acentos y en cualquier orden", async () => {
    expect(await idsProveedoresQueCoinciden(companyId, "medica")).toEqual([previo]);
    expect(await idsProveedoresQueCoinciden(companyId, "sur distribuidora")).toEqual([previo]);
    expect(await idsProveedoresQueCoinciden(companyId, "dme0101")).toEqual([previo]);
  });

  it("da de alta al emisor que ya facturó y no estaba en el padrón (no al cancelado)", async () => {
    const ids = await idsProveedoresQueCoinciden(companyId, "euro");
    expect(ids).toHaveLength(1);
    const p = await prisma.supplier.findUniqueOrThrow({ where: { id: ids[0] } });
    expect(p).toMatchObject({ rfc: "EUR020202BB2", razonSocial: "EUROWIPE SA DE CV" });
    // Idempotente: buscar otra vez no lo duplica.
    expect(await idsProveedoresQueCoinciden(companyId, "eurowipe")).toEqual(ids);
    expect(await prisma.supplier.count({ where: { companyId } })).toBe(2);
  });
});
