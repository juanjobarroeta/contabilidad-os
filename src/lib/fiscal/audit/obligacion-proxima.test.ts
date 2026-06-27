import { describe, it, expect } from "vitest";
import {
  auditarObligacionProxima,
  type ObligacionProximaData,
} from "./obligacion-proxima";

// Una obligación mensual de IVA que vence el día 17, con un set opcional de
// declaraciones ya presentadas (FILED/PAID) por clave "tipo:periodo".
const data = (presentadas: string[] = []): ObligacionProximaData => ({
  obligaciones: [{ tipo: "IVA_MENSUAL", diaVencimiento: 17 }],
  presentadas: new Set(presentadas),
});

describe("auditarObligacionProxima", () => {
  it("dentro de la ventana (≤7 días antes, sin presentar) → warn", () => {
    // 12-jul-2026: periodo en juego = junio (vence 17-jul, faltan 5 días).
    const out = auditarObligacionProxima(data(), new Date(2026, 6, 12));
    expect(out).toHaveLength(1);
    const h = out[0];
    expect(h.checkClave).toBe("obligacion.vencimiento.proximo");
    expect(h.severidad).toBe("warn");
    expect(h.referencias).toEqual(["IVA_MENSUAL:2026-06"]);
    expect(h.mensaje).toContain("junio");
    expect(h.mensaje).toContain("vence el 17");
    expect(h.fundamento.ley).toBe("LIVA");
  });

  it("el mismo día del vencimiento (17, sin presentar) → warn (aún a tiempo)", () => {
    // 17-jul-2026: vence hoy (fin del día) → todavía a tiempo → warn.
    const out = auditarObligacionProxima(data(), new Date(2026, 6, 17));
    expect(out).toHaveLength(1);
    expect(out[0].severidad).toBe("warn");
    expect(out[0].referencias).toEqual(["IVA_MENSUAL:2026-06"]);
  });

  it("pasado el vencimiento (sin presentar) → error", () => {
    // 20-jul-2026: el 17-jul ya pasó y junio sigue sin presentar → vencido.
    const out = auditarObligacionProxima(data(), new Date(2026, 6, 20));
    expect(out).toHaveLength(1);
    const h = out[0];
    expect(h.severidad).toBe("error");
    expect(h.referencias).toEqual(["IVA_MENSUAL:2026-06"]);
    expect(h.mensaje).toContain("venció el 17");
    expect(h.mensaje).toContain("junio");
  });

  it("ya presentada (FILED/PAID) → sin hallazgo", () => {
    // Aun pasado el vencimiento, si está presentada no se reporta.
    const out = auditarObligacionProxima(
      data(["IVA_MENSUAL:2026-06"]),
      new Date(2026, 6, 20),
    );
    expect(out).toEqual([]);
  });

  it("lejos del vencimiento (>7 días antes) → sin hallazgo", () => {
    // 1-jul-2026: periodo en juego = junio (vence 17-jul, faltan 16 días).
    const out = auditarObligacionProxima(data(), new Date(2026, 6, 1));
    expect(out).toEqual([]);
  });

  it("cruce de año: enero mira a diciembre del año anterior", () => {
    // 16-ene-2026: periodo en juego = diciembre 2025 (vence 17-ene-2026).
    const out = auditarObligacionProxima(data(), new Date(2026, 0, 16));
    expect(out).toHaveLength(1);
    expect(out[0].severidad).toBe("warn");
    expect(out[0].referencias).toEqual(["IVA_MENSUAL:2025-12"]);
    expect(out[0].mensaje).toContain("diciembre");
  });
});
