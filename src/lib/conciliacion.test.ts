import { describe, it, expect } from "vitest";
import {
  checkInvoiceMatchGuard,
  checkSumaAsignada,
  mergePagosConciliados,
  PPD_ACUMULADO_TOLERANCIA,
} from "./conciliacion";

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

// ── Conciliación múltiple: porciones asignadas (montoAsignado) ────────────────
//
// Un movimiento que paga varias facturas asigna a cada una una PORCIÓN
// (ConciliacionDetalle.montoAsignado). El guard debe contar esas porciones,
// no el movimiento completo.

describe("checkInvoiceMatchGuard — porciones asignadas (conciliación múltiple)", () => {
  const pue = { metodoPago: "PUE", total: 9628 };
  const ppd = { metodoPago: "PPD", total: 1000 };
  // Un pago previo que entró como porción asignada de otro movimiento.
  const asignado = (id: string, montoTx: number, montoAsignado: number, fecha = "2026-06-10") => ({
    id,
    monto: montoTx,
    montoAsignado,
    fecha: new Date(`${fecha}T00:00:00Z`),
  });

  it("PUE pagada junto con otras facturas en UNA transferencia es VÁLIDA (porción = total)", () => {
    // Transferencia de $56,254 que cubre 5 facturas de ~$9,628: la porción
    // asignada a esta PUE es exactamente su total — sigue siendo una sola exhibición.
    const r = checkInvoiceMatchGuard(pue, [], { id: "tx_1", monto: 56254, montoAsignado: 9628 });
    expect(r).toEqual({ ok: true });
  });

  it("PUE con porción dentro de la tolerancia del 1% también es válida", () => {
    const r = checkInvoiceMatchGuard(pue, [], { id: "tx_1", monto: 56200, montoAsignado: 9628 * 0.995 });
    expect(r).toEqual({ ok: true });
  });

  it("PUE RECHAZA una porción que no cubre el total (más allá del 1%)", () => {
    const r = checkInvoiceMatchGuard(pue, [], { id: "tx_1", monto: 56254, montoAsignado: 5000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("una sola exhibición");
  });

  it("PUE RECHAZA un segundo pago encima de una porción ya asignada", () => {
    const r = checkInvoiceMatchGuard(pue, [asignado("tx_1", 56254, 9628)], {
      id: "tx_2",
      monto: 9628,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ya está conciliada con otro movimiento");
  });

  it("PUE: el mensaje del segundo pago reporta la PORCIÓN previa, no el movimiento completo", () => {
    const r = checkInvoiceMatchGuard(pue, [asignado("tx_1", 56254, 9628)], {
      id: "tx_2",
      monto: 9628,
    });
    if (!r.ok) {
      expect(r.error).toContain("$9,628.00");
      expect(r.error).not.toContain("$56,254.00");
    }
  });

  it("PPD acumula porciones asignadas + matches legados sin exceder el total", () => {
    // Legado 1:1 de $400 + porción de $300 → nueva porción de $300 completa el total.
    const r = checkInvoiceMatchGuard(
      ppd,
      [matched("tx_1", 400), asignado("tx_2", 5000, 300)],
      { id: "tx_3", monto: 2000, montoAsignado: 300 },
    );
    expect(r).toEqual({ ok: true });
  });

  it("PPD RECHAZA cuando la nueva porción excedería el total (detalle + legado)", () => {
    // 400 (legado) + 300 (porción) + 400 (nueva porción) = 1100 > 1010
    const r = checkInvoiceMatchGuard(
      ppd,
      [matched("tx_1", 400), asignado("tx_2", 5000, 300)],
      { id: "tx_3", monto: 2000, montoAsignado: 400 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("excedería el total");
  });

  it("PPD: una primera porción mayor al total se rechaza (a diferencia del match legado)", () => {
    const r = checkInvoiceMatchGuard(ppd, [], { id: "tx_1", monto: 5000, montoAsignado: 1200 });
    expect(r.ok).toBe(false);
  });

  it("PPD legado sin porción: el primer match 1:1 no valida monto contra total (compatibilidad)", () => {
    const r = checkInvoiceMatchGuard(ppd, [], { id: "tx_1", monto: 5000 });
    expect(r).toEqual({ ok: true });
  });
});

describe("mergePagosConciliados", () => {
  const fecha = new Date("2026-06-10T00:00:00Z");

  it("une matches legados y porciones asignadas", () => {
    const out = mergePagosConciliados(
      [{ id: "tx_1", fecha, monto: 400 }],
      [{ bankTransactionId: "tx_2", montoAsignado: 300, bankTransaction: { fecha, monto: 5000 } }],
    );
    expect(out).toHaveLength(2);
    expect(out.find((p) => p.id === "tx_1")?.montoAsignado).toBeUndefined();
    expect(out.find((p) => p.id === "tx_2")?.montoAsignado).toBe(300);
  });

  it("si un movimiento aparece en ambos lados, gana la porción asignada", () => {
    const out = mergePagosConciliados(
      [{ id: "tx_1", fecha, monto: 5000 }],
      [{ bankTransactionId: "tx_1", montoAsignado: 300, bankTransaction: { fecha, monto: 5000 } }],
    );
    expect(out).toHaveLength(1);
    expect(out[0].montoAsignado).toBe(300);
  });
});

// ── Σ de montos asignados vs monto del movimiento ─────────────────────────────

describe("checkSumaAsignada", () => {
  it("suma exacta: ok sin advertencia", () => {
    const r = checkSumaAsignada(56254, [{ monto: 9628 }, { monto: 9628 }, { monto: 9628 }, { monto: 9628 }, { monto: 17742 }]);
    expect(r).toEqual({ ok: true, advertencia: null });
  });

  it("por debajo del movimiento (más del 1%): ok CON advertencia", () => {
    const r = checkSumaAsignada(1000, [{ monto: 400 }, { monto: 400 }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.advertencia?.codigo).toBe("SUMA_MENOR_AL_MOVIMIENTO");
      expect(r.advertencia?.sumaAsignada).toBe(800);
      expect(r.advertencia?.montoMovimiento).toBe(1000);
    }
  });

  it("por debajo pero dentro de la tolerancia del 1%: ok sin advertencia", () => {
    const r = checkSumaAsignada(1000, [{ monto: 500 }, { monto: 495 }]);
    expect(r).toEqual({ ok: true, advertencia: null });
  });

  it("por encima del movimiento (más del 1%): RECHAZADO", () => {
    const r = checkSumaAsignada(1000, [{ monto: 600 }, { monto: 600 }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("excede el monto del movimiento");
  });

  it("usa valor absoluto del movimiento (retiros, monto negativo)", () => {
    const r = checkSumaAsignada(-1000, [{ monto: 500 }, { monto: 500 }]);
    expect(r).toEqual({ ok: true, advertencia: null });
  });
});
