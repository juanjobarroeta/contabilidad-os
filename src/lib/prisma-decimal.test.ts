import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { decimalesANumero } from "./prisma-decimal";

const D = (s: string) => new Prisma.Decimal(s);

describe("decimalesANumero", () => {
  it("primitivos y null/undefined pasan intactos", () => {
    expect(decimalesANumero(null)).toBeNull();
    expect(decimalesANumero(undefined)).toBeUndefined();
    expect(decimalesANumero(42)).toBe(42);
    expect(decimalesANumero("123.45")).toBe("123.45");
    expect(decimalesANumero(true)).toBe(true);
  });

  it("un Decimal raíz se vuelve number (caso _sum directo)", () => {
    expect(decimalesANumero(D("123.45"))).toBe(123.45);
    expect(decimalesANumero(D("-0.000001"))).toBe(-0.000001);
  });

  it("convierte en profundidad: objetos, arreglos y anidados", () => {
    const fila = {
      id: "abc",
      total: D("1160.00"),
      taxes: [
        { tipo: "IVA", importe: D("160.000000") },
        { tipo: "ISR", importe: null },
      ],
      _sum: { total: D("99999.99") },
    };
    const out = decimalesANumero(fila);
    expect(out.total).toBe(1160);
    expect(out.taxes[0].importe).toBe(160);
    expect(out.taxes[1].importe).toBeNull();
    expect(out._sum.total).toBe(99999.99);
  });

  it("respeta Date y Uint8Array", () => {
    const fecha = new Date("2026-08-26T00:00:00Z");
    const bytes = new Uint8Array([1, 2, 3]);
    const out = decimalesANumero({ fecha, bytes, monto: D("10.50") });
    expect(out.fecha).toBe(fecha);
    expect(out.bytes).toBe(bytes);
    expect(out.monto).toBe(10.5);
  });

  it("resultado de groupBy: arreglo de filas con _sum y _count", () => {
    const rows = [
      { companyId: "c1", _count: 5, _sum: { monto: D("500.25") } },
      { companyId: "c2", _count: 0, _sum: { monto: null } },
    ];
    const out = decimalesANumero(rows);
    expect(out[0]._sum.monto).toBe(500.25);
    expect(out[1]._sum.monto).toBeNull();
    expect(out[1]._count).toBe(0);
  });

  it("magnitud fuera del rango seguro avisa por console.error (no truncar en silencio)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = decimalesANumero({ monto: D("9007199254740993") });
      expect(typeof out.monto).toBe("number");
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });
});
