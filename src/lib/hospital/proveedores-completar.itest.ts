import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { completarProveedor } from "./proveedores";

const skip = process.env.DB_TESTS_SKIP === "1";

describe.skipIf(skip)("completar proveedor (real)", () => {
  let companyId = "";
  let s1 = "";
  let s2 = "";
  beforeAll(async () => {
    companyId = (await prisma.company.create({ data: { rfc: `CPL${Date.now() % 1000000}AA1`, razonSocial: "Hospital completar iTest", regimenFiscal: "601", codigoPostal: "72000" } })).id;
    s1 = (await prisma.supplier.create({ data: { companyId, rfc: "CPA010101AA1", razonSocial: "SIN DATOS" } })).id;
    s2 = (await prisma.supplier.create({ data: { companyId, rfc: "CPB010101AA1", razonSocial: "CON DATOS", clabe: "002180000000000001", terms: { create: { tieneCredito: false, diasCredito: 0 } } } })).id;
  });
  afterAll(async () => {
    await prisma.supplier.deleteMany({ where: { companyId } });
    await prisma.company.delete({ where: { id: companyId } });
    await prisma.$disconnect();
  });

  it("llena lo que falta y respeta lo registrado", async () => {
    const d = { clabe: "012180001234567891", banco: "BBVA", titularCuenta: "Juan", tieneCredito: true, diasCredito: 30 };
    expect(await completarProveedor(prisma, companyId, s1, d)).toEqual({ guardados: ["cuenta", "credito"], omitidos: [] });
    expect(await completarProveedor(prisma, companyId, s2, d)).toEqual({ guardados: [], omitidos: ["cuenta", "credito"] });
    const [a, b] = await Promise.all([s1, s2].map((id) => prisma.supplier.findUniqueOrThrow({ where: { id }, select: { clabe: true, banco: true, terms: { select: { tieneCredito: true, diasCredito: true } } } })));
    expect(a).toEqual({ clabe: "012180001234567891", banco: "BBVA", terms: { tieneCredito: true, diasCredito: 30 } });
    expect(b).toEqual({ clabe: "002180000000000001", banco: null, terms: { tieneCredito: false, diasCredito: 0 } });
    // Segunda vez ya no hay nada que llenar.
    expect(await completarProveedor(prisma, companyId, s1, { clabe: "014180000000000002" })).toEqual({ guardados: [], omitidos: ["cuenta"] });
    expect(await completarProveedor(prisma, "otra", s1, d)).toBeNull();
  });
});
