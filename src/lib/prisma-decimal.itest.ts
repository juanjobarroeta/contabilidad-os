import { describe, expect, it, afterAll } from "vitest";
import { prisma } from "./prisma";

// Guardia de integración del convertidor Decimal→number (docs/FLOAT-DECIMAL.md):
// el cliente compartido debe entregar `number` para columnas NUMERIC en TODOS
// los caminos — crudo, modelo y aggregate. Si alguien quita la extensión de
// src/lib/prisma.ts, esto truena antes que producción.
const skip = process.env.DB_TESTS_SKIP === "1";

describe.skipIf(skip)("cliente compartido: NUMERIC llega como number", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("$queryRaw: numeric escalar y SUM(numeric) exacto", async () => {
    const [row] = await prisma.$queryRaw<Array<{ x: unknown; s: unknown }>>`
      SELECT 123.456789::numeric(18,6) AS x, SUM(v)::numeric AS s
      FROM (VALUES (0.1::numeric), (0.2::numeric)) AS t(v)`;
    expect(typeof row.x).toBe("number");
    expect(row.x).toBe(123.456789);
    expect(typeof row.s).toBe("number");
    // La razón de toda la migración: en numeric, 0.1 + 0.2 SÍ es 0.3.
    expect(row.s).toBe(0.3);
  });

  it("modelo con columna Decimal (SupplierTerms.limiteCredito): number en el resultado", async () => {
    const company = await prisma.company.create({
      data: {
        rfc: `ITESTDEC010101X${Date.now() % 100}`,
        razonSocial: "Decimal iTest SA",
        regimenFiscal: "601",
        codigoPostal: "06600",
      },
    });
    const supplier = await prisma.supplier.create({
      data: { companyId: company.id, rfc: "ITESTPRV010101PP1", razonSocial: "Proveedor iTest" },
    });
    try {
      const terms = await prisma.supplierTerms.create({
        data: { supplierId: supplier.id, tieneCredito: true, diasCredito: 30, limiteCredito: 50000.5 },
      });
      expect(typeof terms.limiteCredito).toBe("number");
      expect(terms.limiteCredito).toBe(50000.5);

      const leido = await prisma.supplierTerms.findUnique({ where: { id: terms.id } });
      expect(typeof leido?.limiteCredito).toBe("number");
      expect(leido?.limiteCredito).toBe(50000.5);

      // Serialización de API: number plano, no string de Decimal.
      expect(JSON.parse(JSON.stringify(leido)).limiteCredito).toBe(50000.5);
    } finally {
      await prisma.supplier.delete({ where: { id: supplier.id } });
      await prisma.company.delete({ where: { id: company.id } });
    }
  });
});
