import { describe, expect, it, vi } from "vitest";
import { iepsDelPeriodo } from "./ieps";

/** Prisma falso: sólo hace falta que `invoiceTax.findMany` devuelva renglones. */
function prismaCon(renglones: unknown[]) {
  return {
    invoiceTax: { findMany: vi.fn().mockResolvedValue(renglones) },
  } as never;
}

const r = (
  importe: number,
  tipo: "INGRESO" | "EGRESO",
  { tasa = 0.08, retencion = false } = {}
) => ({ importe, tasa, retencion, invoice: { tipo } });

describe("iepsDelPeriodo", () => {
  it("separa lo que cobra de lo que le cobran", async () => {
    const ieps = await iepsDelPeriodo(
      prismaCon([r(1000, "INGRESO"), r(400, "EGRESO"), r(500, "INGRESO")]),
      "c1",
      2026,
      8
    );
    expect(ieps.trasladado).toBe(1500);
    expect(ieps.pagado).toBe(400);
    expect(ieps.neto).toBe(1100);
    expect(ieps.renglones).toBe(3);
  });

  it("NO suma las retenciones de IEPS: se enteran aparte", async () => {
    // Sumarlas inflaría los dos lados y el neto quedaría igual, escondiendo el
    // error — por eso la prueba mira trasladado, no sólo el neto.
    const ieps = await iepsDelPeriodo(
      prismaCon([r(1000, "INGRESO"), r(300, "INGRESO", { retencion: true })]),
      "c1",
      2026,
      8
    );
    expect(ieps.trasladado).toBe(1000);
    expect(ieps.renglones).toBe(1);
  });

  it("agrupa por tasa — el 8 % del abarrote no se mezcla con otras", async () => {
    const ieps = await iepsDelPeriodo(
      prismaCon([
        r(800, "INGRESO", { tasa: 0.08 }),
        r(530, "INGRESO", { tasa: 0.53 }),
        r(200, "EGRESO", { tasa: 0.08 }),
      ]),
      "c1",
      2026,
      8
    );
    expect(ieps.porTasa).toHaveLength(2);
    // Ordenado de mayor a menor tasa.
    expect(ieps.porTasa[0].tasa).toBe(0.53);
    const ocho = ieps.porTasa.find((t) => t.tasa === 0.08)!;
    expect(ocho.trasladado).toBe(800);
    expect(ocho.pagado).toBe(200);
  });

  it("se declara DERIVADO y por fecha de CFDI, no por flujo", async () => {
    // Estas dos banderas son el contrato con la UI: sin ellas la pantalla
    // podría enseñar el neto como si fuera un saldo a enterar.
    const ieps = await iepsDelPeriodo(prismaCon([r(100, "INGRESO")]), "c1", 2026, 8);
    expect(ieps.derivado).toBe(true);
    expect(ieps.baseFecha).toBe("CFDI");
  });

  it("sin renglones, `hay` es false y no se pinta nada", async () => {
    const ieps = await iepsDelPeriodo(prismaCon([]), "c1", 2026, 8);
    expect(ieps.hay).toBe(false);
    expect(ieps.trasladado).toBe(0);
    expect(ieps.neto).toBe(0);
  });

  it("pide sólo el mes, y sólo CFDIs vigentes de ingreso y egreso", async () => {
    const prisma = prismaCon([]);
    await iepsDelPeriodo(prisma, "c1", 2026, 8);
    const where = (prisma as never as { invoiceTax: { findMany: { mock: { calls: [{ where: Record<string, never> }][] } } } })
      .invoiceTax.findMany.mock.calls[0][0].where as Record<string, never>;
    const inv = where.invoice as unknown as {
      companyId: string;
      status: { not: string };
      fecha: { gte: Date; lt: Date };
      tipo: { in: string[] };
    };
    expect(inv.companyId).toBe("c1");
    expect(inv.status.not).toBe("CANCELLED");
    expect(inv.tipo.in).toEqual(["INGRESO", "EGRESO"]);
    // Agosto de 2026, en UTC, sin arrastrar septiembre.
    expect(inv.fecha.gte.toISOString().slice(0, 10)).toBe("2026-08-01");
    expect(inv.fecha.lt.toISOString().slice(0, 10)).toBe("2026-09-01");
  });
});
