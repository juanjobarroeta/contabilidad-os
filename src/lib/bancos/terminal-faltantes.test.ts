import { describe, it, expect } from "vitest";
import {
  afiliacionDeLiquidacion,
  faltantesDeTerminal,
  lotesDeTerminal,
  periodoDe,
  type MovimientoTerminal,
} from "./terminal-faltantes";

const HOY = new Date("2026-09-14T12:00:00Z");

const mov = (id: string, fecha: string, descripcion: string, monto = -1000): MovimientoTerminal => ({
  id,
  fecha: new Date(`${fecha}T00:00:00Z`),
  descripcion,
  monto,
});

describe("afiliacionDeLiquidacion", () => {
  it("saca el número de afiliación, no sólo el tipo de tarjeta", () => {
    expect(afiliacionDeLiquidacion("HOSP HALTUS 09992888C")).toBe("09992888");
    expect(afiliacionDeLiquidacion("HOSP HALTUS 09992886D")).toBe("09992886");
  });

  it("sin sufijo de tarjeta no hay afiliación legible", () => {
    expect(afiliacionDeLiquidacion("DEPOSITO VENTAS DEL DIA AFIL.-009951074")).toBeNull();
    expect(afiliacionDeLiquidacion("SPEI RECIBIDO BANORTE")).toBeNull();
    expect(afiliacionDeLiquidacion("")).toBeNull();
  });
});

describe("periodoDe", () => {
  it("usa UTC: una fecha bancaria es un día, no un instante", () => {
    expect(periodoDe(new Date("2026-03-01T00:00:00Z"))).toBe("2026-03");
    expect(periodoDe(new Date("2026-12-31T00:00:00Z"))).toBe("2026-12");
  });
});

describe("lotesDeTerminal", () => {
  it("agrupa por mes Y por afiliación: dos terminales son dos pedidos", () => {
    const lotes = lotesDeTerminal([
      mov("a", "2026-07-05", "HOSP HALTUS 09992888C"),
      mov("b", "2026-07-06", "HOSP HALTUS 09992886D"),
    ]);
    expect(lotes).toHaveLength(2);
    expect(lotes.map((l) => l.afiliacion).sort()).toEqual(["09992886", "09992888"]);
  });

  it("suma los movimientos de una misma afiliación en el mes", () => {
    const lotes = lotesDeTerminal([
      mov("a", "2026-07-05", "HOSP HALTUS 09992888C", -1000),
      mov("b", "2026-07-20", "HOSP HALTUS 09992888C", -2500),
    ]);
    expect(lotes).toHaveLength(1);
    expect(lotes[0].total).toBe(3500);
    expect(lotes[0].movimientos).toEqual(["a", "b"]);
  });

  it("una afiliación con crédito y débito no se declara de un solo tipo", () => {
    // Inventar «es de crédito» cuando hay de las dos sería precisión falsa.
    const lotes = lotesDeTerminal([
      mov("a", "2026-07-05", "TERMINAL 1234567C"),
      mov("b", "2026-07-06", "TERMINAL 1234567D"),
    ]);
    expect(lotes).toHaveLength(1);
    expect(lotes[0].tarjeta).toBeNull();
  });

  it("ignora lo que no es liquidación de terminal", () => {
    expect(lotesDeTerminal([mov("a", "2026-07-05", "SPEI RECIBIDO")])).toEqual([]);
  });

  it("los meses más recientes van primero", () => {
    const lotes = lotesDeTerminal([
      mov("a", "2026-05-05", "TERMINAL 1234567C"),
      mov("b", "2026-07-05", "TERMINAL 1234567C"),
    ]);
    expect(lotes.map((l) => l.periodo)).toEqual(["2026-07", "2026-05"]);
  });
});

describe("faltantesDeTerminal", () => {
  const lotes = lotesDeTerminal([
    mov("a", "2026-07-05", "HOSP HALTUS 09992888C", -30000),
    mov("b", "2026-09-05", "HOSP HALTUS 09992888C", -12000),
  ]);

  it("no pide el mes en curso: el adquirente todavía no lo cierra", () => {
    // Un pedido que el cliente no puede atender enseña a ignorar los pedidos.
    const f = faltantesDeTerminal(lotes, new Set(), HOY);
    expect(f.map((x) => x.periodo)).toEqual(["2026-07"]);
  });

  it("no repite lo que ya llegó", () => {
    const f = faltantesDeTerminal(lotes, new Set(["terminal:2026-07:09992888"]), HOY);
    expect(f).toEqual([]);
  });

  it("dice cuánto depositó el banco, para que el pedido se entienda solo", () => {
    const [f] = faltantesDeTerminal(lotes, new Set(), HOY);
    expect(f.detalle).toContain("$30,000.00");
    expect(f.detalle).toContain("09992888");
  });

  it("la llave es mes + afiliación: el mismo hueco no se vuelve a pedir mañana", () => {
    const [f] = faltantesDeTerminal(lotes, new Set(), HOY);
    expect(f.dedupeKey).toBe("terminal:2026-07:09992888");
  });
});
