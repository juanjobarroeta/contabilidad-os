import { describe, expect, it } from "vitest";
import {
  auditarBalanceDescuadre,
  TOLERANCIA_DESCUADRE,
  type BalanceDescuadre,
} from "./balance-descuadre";

const base: BalanceDescuadre = {
  companyId: "c1",
  periodo: { year: 2025, month: 12 },
  totalActivo: 1_000_000,
  descuadre: 0,
  saldoEfectivo: 250_000,
  saldoPorCobrar: 400_000,
};

const con = (o: Partial<BalanceDescuadre>) => auditarBalanceDescuadre({ ...base, ...o });

describe("auditarBalanceDescuadre", () => {
  it("un balance sano no dice nada", () => {
    expect(con({})).toEqual([]);
  });

  it("sin periodo posteado no hay balance que juzgar", () => {
    expect(con({ periodo: null })).toEqual([]);
  });

  it("activo en cero no produce división por cero ni hallazgo", () => {
    expect(con({ totalActivo: 0, descuadre: 5_000 })).toEqual([]);
  });

  describe("falta el lado del efectivo", () => {
    it("cartera sin un peso en caja ni bancos es el hallazgo específico", () => {
      // El caso real: AUTOMOTRIZ MARGOM cerró 2025 con $4,044 millones en
      // clientes y CERO en efectivo — se postea la factura, nunca el cobro.
      const [h] = con({ saldoEfectivo: 0, saldoPorCobrar: 4_044_520_545, totalActivo: 4_044_520_545 });
      expect(h.checkClave).toBe("contabilidad.sin_lado_efectivo");
      expect(h.severidad).toBe("error");
      expect(h.mensaje).toMatch(/CERO en caja y bancos/);
      expect(h.sugerencia).toMatch(/concilia/i);
    });

    it("gana al hallazgo genérico: no se levantan los dos", () => {
      // Si falta el efectivo, ÉSA es la causa del descuadre; decir además
      // "no cuadra" es ruido sobre el mismo problema.
      const hs = con({ saldoEfectivo: 0, saldoPorCobrar: 4_000_000, descuadre: 900_000 });
      expect(hs).toHaveLength(1);
      expect(hs[0].checkClave).toBe("contabilidad.sin_lado_efectivo");
    });

    it("sin cartera no se reclama la falta de efectivo", () => {
      // Una empresa recién dada de alta no debe recibir este regaño.
      expect(con({ saldoEfectivo: 0, saldoPorCobrar: 0 })).toEqual([]);
    });

    it("con algo de efectivo ya no aplica el caso específico", () => {
      const hs = con({ saldoEfectivo: 1, saldoPorCobrar: 4_000_000 });
      expect(hs.map((h) => h.checkClave)).not.toContain("contabilidad.sin_lado_efectivo");
    });
  });

  describe("descuadre de la ecuación contable", () => {
    it("levanta el hallazgo cuando pasa la tolerancia", () => {
      const [h] = con({ descuadre: 200_000 }); // 20% del activo
      expect(h.checkClave).toBe("contabilidad.balance_descuadrado");
      expect(h.severidad).toBe("error");
      expect(h.mensaje).toMatch(/20\.0%/);
    });

    it("un descuadre de redondeo no molesta a nadie", () => {
      expect(con({ descuadre: 50 })).toEqual([]); // 0.005%
      expect(con({ descuadre: TOLERANCIA_DESCUADRE * base.totalActivo })).toEqual([]);
    });

    it("el descuadre negativo cuenta igual que el positivo", () => {
      expect(con({ descuadre: -200_000 })).toHaveLength(1);
      expect(con({ descuadre: -200_000 })[0].mensaje).not.toMatch(/-\$/);
    });

    it("dedupea por empresa: no se acumula uno por corrida", () => {
      const a = con({ descuadre: 200_000 })[0];
      const b = con({ descuadre: 300_000 })[0];
      expect(a.dedupeRef).toBe(b.dedupeRef);
    });
  });
});
