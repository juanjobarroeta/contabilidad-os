import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { precioAlEntrar, recalcularPrecios, TABLA_SUGERIDA, tablaDe } from "./factores-precio";

const skip = process.env.DB_TESTS_SKIP === "1";

describe.skipIf(skip)("factores de precio contra la base", () => {
  let companyId = "";
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    companyId = (await prisma.company.create({ data: { rfc: `FAC${Date.now() % 1000000}AA1`, razonSocial: "Hospital factores iTest", regimenFiscal: "601", codigoPostal: "72000" } })).id;
    for (const [clave, ultimoCosto, precioVenta, precioFijo] of [
      ["BARATO", 10, null, false],
      ["CARO", 600, 100, false],
      ["FIJO", 600, 999, true],
    ] as const) {
      ids[clave] = (await prisma.hospInsumo.create({ data: { companyId, clave, nombre: clave, ultimoCosto, precioVenta, precioFijo } })).id;
    }
  });
  afterAll(async () => {
    await prisma.hospInsumo.deleteMany({ where: { companyId } });
    await prisma.hospConfig.deleteMany({ where: { companyId } });
    await prisma.company.delete({ where: { id: companyId } });
    await prisma.$disconnect();
  });

  it("sin tabla no toca precios", async () => {
    expect(await tablaDe(prisma, companyId)).toBeNull();
    expect(await precioAlEntrar(prisma, companyId, ids.BARATO, 10)).toBeNull();
  });

  it("con tabla: la entrada fija el precio, salvo el precio fijo", async () => {
    await prisma.hospConfig.create({ data: { companyId, factoresPrecio: TABLA_SUGERIDA as unknown as object } });
    expect(await tablaDe(prisma, companyId)).toEqual(TABLA_SUGERIDA);
    expect(await precioAlEntrar(prisma, companyId, ids.BARATO, 12)).toBe(60);
    expect(await precioAlEntrar(prisma, companyId, ids.FIJO, 600)).toBeNull();
    expect(Number((await prisma.hospInsumo.findUniqueOrThrow({ where: { id: ids.FIJO } })).precioVenta)).toBe(999);
  });

  it("recalcular: vista previa sin escribir y luego aplicar", async () => {
    const tabla = (await tablaDe(prisma, companyId))!;
    const previa = await recalcularPrecios(prisma, companyId, tabla, { aplicar: false });
    // BARATO ya quedó en 60 (costo 10 × 5 = 50 con el costo guardado 10): cambia; CARO 100 → 900; FIJO no entra.
    expect(previa.muestra.map((c) => [c.clave, c.despues])).toEqual([["BARATO", 50], ["CARO", 900]]);
    expect(Number((await prisma.hospInsumo.findUniqueOrThrow({ where: { id: ids.CARO } })).precioVenta)).toBe(100);
    await recalcularPrecios(prisma, companyId, tabla, { aplicar: true });
    expect(Number((await prisma.hospInsumo.findUniqueOrThrow({ where: { id: ids.CARO } })).precioVenta)).toBe(900);
    expect(Number((await prisma.hospInsumo.findUniqueOrThrow({ where: { id: ids.FIJO } })).precioVenta)).toBe(999);
  });
});
