import { describe, it, expect } from "vitest";
import {
  diasParaVencimientoMensual,
  debeEnviarProyeccion,
  componerMensajeProyeccion,
  mesNombreCapitalizado,
} from "./proyeccion-declaracion";

// Régimen 601 (PM general) tiene IVA/ISR/DIOT mensuales (vencen el 17).
// En julio-2026 el periodo en juego es JUNIO; el 17-jul-2026 es viernes (hábil),
// así que el vencimiento no se corre.
describe("diasParaVencimientoMensual", () => {
  it("periodo en juego = mes natural anterior; vence el 17 del mes de hoy", () => {
    const r = diasParaVencimientoMensual("601", new Date(2026, 6, 1)); // 1-jul
    expect(r).not.toBeNull();
    expect(r!.periodo).toBe("2026-06");
    expect(r!.year).toBe(2026);
    expect(r!.month).toBe(6);
    expect(r!.mesNombre).toBe("junio");
    expect(r!.vencimiento.getDate()).toBe(17);
    expect(r!.vencimiento.getMonth()).toBe(6); // julio (0-based)
  });

  it("T-7: el 10-jul-2026 faltan 7 días para el 17", () => {
    const r = diasParaVencimientoMensual("601", new Date(2026, 6, 10));
    expect(r!.dias).toBe(7);
  });

  it("T-3: el 14-jul-2026 faltan 3 días para el 17", () => {
    const r = diasParaVencimientoMensual("601", new Date(2026, 6, 14));
    expect(r!.dias).toBe(3);
  });

  it("el mismo día del vencimiento → 0 días", () => {
    const r = diasParaVencimientoMensual("601", new Date(2026, 6, 17));
    expect(r!.dias).toBe(0);
  });

  it("cruce de año: en enero el periodo en juego es diciembre del año anterior", () => {
    const r = diasParaVencimientoMensual("601", new Date(2026, 0, 5)); // 5-ene-2026
    expect(r!.periodo).toBe("2025-12");
    expect(r!.year).toBe(2025);
    expect(r!.month).toBe(12);
  });

  it("corre al día hábil si el 17 cae en fin de semana", () => {
    // 17-ene-2026 es sábado → vencimiento se corre al lunes 19.
    const r = diasParaVencimientoMensual("601", new Date(2026, 0, 1));
    expect(r!.vencimiento.getDate()).toBe(19);
    expect(r!.vencimiento.getDay()).toBe(1); // lunes
  });

  it("régimen sin obligaciones mensuales (621 RIF bimestral) → null", () => {
    expect(diasParaVencimientoMensual("621", new Date(2026, 6, 10))).toBeNull();
  });

  it("régimen sin obligaciones (616) → null", () => {
    expect(diasParaVencimientoMensual("616", new Date(2026, 6, 10))).toBeNull();
  });
});

describe("debeEnviarProyeccion", () => {
  it("dispara exactamente en T-7", () => {
    expect(debeEnviarProyeccion(7)).toBe(7);
  });
  it("dispara exactamente en T-3", () => {
    expect(debeEnviarProyeccion(3)).toBe(3);
  });
  it("no dispara fuera de las marcas (idempotente entre marcas)", () => {
    for (const d of [10, 8, 6, 5, 4, 2, 1, 0, -1]) {
      expect(debeEnviarProyeccion(d)).toBeNull();
    }
  });
});

describe("componerMensajeProyeccion", () => {
  it("incluye IVA a pagar e ISR estimados y la llamada a aprobar", () => {
    const msg = componerMensajeProyeccion("junio", {
      ivaPagar: 12345,
      ivaSaldoAFavor: 0,
      isrPagar: 6789,
    });
    expect(msg).toContain("Proyección de junio");
    expect(msg).toContain("IVA ~");
    expect(msg).toContain("ISR ~");
    expect(msg).toContain("Revisa y aprueba.");
    expect(msg).not.toContain("complemento");
  });

  it("muestra IVA a favor cuando no hay IVA a pagar", () => {
    const msg = componerMensajeProyeccion("junio", {
      ivaPagar: 0,
      ivaSaldoAFavor: 5000,
      isrPagar: null,
    });
    expect(msg).toContain("IVA a favor ~");
    expect(msg).not.toContain("ISR ~");
  });

  it("omite ISR cuando es null (régimen sin ISR mensual)", () => {
    const msg = componerMensajeProyeccion("junio", {
      ivaPagar: 100,
      ivaSaldoAFavor: 0,
      isrPagar: null,
    });
    expect(msg).not.toContain("ISR");
  });

  it("menciona complementos faltantes cuando los hay (singular/plural)", () => {
    const uno = componerMensajeProyeccion("junio", { ivaPagar: 1, ivaSaldoAFavor: 0, isrPagar: null }, 1);
    expect(uno).toContain("Faltan 1 complemento de pago.");
    const varios = componerMensajeProyeccion("junio", { ivaPagar: 1, ivaSaldoAFavor: 0, isrPagar: null }, 3);
    expect(varios).toContain("Faltan 3 complementos de pago.");
  });

  it("ignora complementos cuando es 0", () => {
    const msg = componerMensajeProyeccion("junio", { ivaPagar: 1, ivaSaldoAFavor: 0, isrPagar: null }, 0);
    expect(msg).not.toContain("complemento");
  });
});

describe("mesNombreCapitalizado", () => {
  it("capitaliza la primera letra", () => {
    expect(mesNombreCapitalizado("junio")).toBe("Junio");
  });
});
