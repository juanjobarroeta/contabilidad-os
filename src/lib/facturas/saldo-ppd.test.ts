import { describe, expect, it } from "vitest";
import { saldoInsolutoPpd } from "./saldo-ppd";

const d = (
  numParcialidad: number | null,
  impPagado: number | null,
  impSaldoInsoluto: number | null,
  fechaPago: string | null = null,
) => ({ numParcialidad, impPagado, impSaldoInsoluto, fechaPago: fechaPago ? new Date(fechaPago) : null });

describe("saldoInsolutoPpd", () => {
  it("sin complementos: todo el total es saldo", () => {
    const r = saldoInsolutoPpd(10_000, []);
    expect(r).toEqual({ saldo: 10_000, pagado: 0, parcialidades: 0, ultimoPago: null });
  });

  it("manda el saldo DECLARADO por el docto más avanzado, no la resta", () => {
    const r = saldoInsolutoPpd(10_000, [
      d(1, 4_000, 6_000, "2026-05-05"),
      d(2, 3_000, 3_000, "2026-06-05"),
    ]);
    expect(r.saldo).toBe(3_000);
    expect(r.pagado).toBe(7_000);
    expect(r.parcialidades).toBe(2);
    expect(r.ultimoPago?.toISOString().slice(0, 10)).toBe("2026-06-05");
  });

  it("a igual (o sin) parcialidad, gana el de fecha de pago más reciente", () => {
    const r = saldoInsolutoPpd(10_000, [
      d(null, 4_000, 6_000, "2026-05-05"),
      d(null, 2_000, 4_000, "2026-07-01"),
    ]);
    expect(r.saldo).toBe(4_000);
  });

  it("sin saldos declarados cae a total − Σ pagado", () => {
    const r = saldoInsolutoPpd(10_000, [d(1, 2_500, null), d(2, 2_500, null)]);
    expect(r.saldo).toBe(5_000);
  });

  it("un complemento chueco no produce saldo negativo ni pagado mayor al total", () => {
    const sobrepagado = saldoInsolutoPpd(10_000, [d(1, 15_000, null)]);
    expect(sobrepagado.saldo).toBe(0);
    expect(sobrepagado.pagado).toBe(10_000);

    const saldoInflado = saldoInsolutoPpd(10_000, [d(1, 0, 25_000)]);
    expect(saldoInflado.saldo).toBe(10_000);
  });
});
