import { describe, it, expect } from "vitest";
import { checkInvoiceMatchGuard, PPD_ACUMULADO_TOLERANCIA } from "./conciliacion";

// checkInvoiceMatchGuard es PURA: recibe la factura y sus movimientos ya
// conciliados, sin tocar la base de datos. Aquí se fija la regla de negocio:
// PUE = un solo movimiento; PPD = parcialidades válidas sin exceder el total.

const matched = (id: string, monto: number, fecha = "2026-06-10") => ({
  id,
  monto,
  fecha: new Date(`${fecha}T00:00:00Z`),
});

describe("checkInvoiceMatchGuard — PUE", () => {
  const pue = { metodoPago: "PUE", total: 1000 };

  it("permite el primer match (sin movimientos previos)", () => {
    expect(checkInvoiceMatchGuard(pue, [], { id: "tx_1", monto: 1000 })).toEqual({ ok: true });
  });

  it("RECHAZA un segundo movimiento sobre una factura ya conciliada", () => {
    const r = checkInvoiceMatchGuard(pue, [matched("tx_1", 1000)], { id: "tx_2", monto: 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Mensaje formal con fecha y monto del match existente.
      expect(r.error).toContain("ya está conciliada con otro movimiento");
      expect(r.error).toContain("2026-06-10");
      expect(r.error).toContain("$1,000.00");
    }
  });

  it("re-conciliar el MISMO movimiento es idempotente (no cuenta como segundo match)", () => {
    const r = checkInvoiceMatchGuard(pue, [matched("tx_1", 1000)], { id: "tx_1", monto: 1000 });
    expect(r).toEqual({ ok: true });
  });

  it("usa valor absoluto: un egreso conciliado (monto negativo) también bloquea", () => {
    const r = checkInvoiceMatchGuard(pue, [matched("tx_1", -1000)], { id: "tx_2", monto: -1000 });
    expect(r.ok).toBe(false);
  });
});

describe("checkInvoiceMatchGuard — PPD (parcialidades)", () => {
  const ppd = { metodoPago: "PPD", total: 1000 };

  it("permite una segunda parcialidad mientras el acumulado quepa en el total", () => {
    const r = checkInvoiceMatchGuard(ppd, [matched("tx_1", 400)], { id: "tx_2", monto: 400 });
    expect(r).toEqual({ ok: true });
  });

  it("permite completar exactamente el total", () => {
    const r = checkInvoiceMatchGuard(ppd, [matched("tx_1", 400), matched("tx_2", 300)], {
      id: "tx_3",
      monto: 300,
    });
    expect(r).toEqual({ ok: true });
  });

  it("tolera hasta 1% por encima del total (redondeos)", () => {
    expect(PPD_ACUMULADO_TOLERANCIA).toBe(0.01);
    // 600 + 405 = 1005 ≤ 1000 * 1.01
    const r = checkInvoiceMatchGuard(ppd, [matched("tx_1", 600)], { id: "tx_2", monto: 405 });
    expect(r).toEqual({ ok: true });
  });

  it("RECHAZA cuando el acumulado excedería claramente el total", () => {
    // 600 + 500 = 1100 > 1010
    const r = checkInvoiceMatchGuard(ppd, [matched("tx_1", 600)], { id: "tx_2", monto: 500 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("excedería el total");
      expect(r.error).toContain("$1,100.00");
      expect(r.error).toContain("$1,000.00");
    }
  });

  it("suma en valor absoluto (parcialidades de egreso, montos negativos)", () => {
    const egresoPpd = { metodoPago: "PPD", total: 1000 };
    const r = checkInvoiceMatchGuard(egresoPpd, [matched("tx_1", -600)], {
      id: "tx_2",
      monto: -500,
    });
    expect(r.ok).toBe(false);
  });

  it("re-conciliar la MISMA parcialidad no duplica su monto en el acumulado", () => {
    const r = checkInvoiceMatchGuard(ppd, [matched("tx_1", 600), matched("tx_2", 400)], {
      id: "tx_2",
      monto: 400,
    });
    expect(r).toEqual({ ok: true });
  });
});
