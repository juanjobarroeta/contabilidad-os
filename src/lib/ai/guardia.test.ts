import { describe, expect, it } from "vitest";
import { decidirUsoIA, periodoActualMx, startOfDayMx, startOfMonthMx, topeMensualEmpresaUsd } from "./guardia";
import {
  IA_OPERACIONES_DIARIAS_USUARIO,
  IA_USD_MENSUAL_PRUEBA,
  IA_USD_MENSUAL_SIN_EMPRESA,
  iaUsdMensualEmpresa,
} from "@/lib/planes";

describe("decidirUsoIA", () => {
  it("permite con gasto bajo y pocas operaciones", () => {
    expect(decidirUsoIA({ gastoEmpresaMesUsd: 1, topeEmpresaMesUsd: 10, operacionesUsuarioHoy: 3 })).toEqual({ ok: true });
  });

  it("bloquea a la empresa al alcanzar su techo mensual", () => {
    const d = decidirUsoIA({ gastoEmpresaMesUsd: 10, topeEmpresaMesUsd: 10, operacionesUsuarioHoy: 0 });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.motivo).toBe("empresa");
  });

  it("el tope diario de operaciones del usuario manda sobre todo lo demás", () => {
    const d = decidirUsoIA({ gastoEmpresaMesUsd: 0, topeEmpresaMesUsd: 100, operacionesUsuarioHoy: IA_OPERACIONES_DIARIAS_USUARIO });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.motivo).toBe("usuario_dia");
  });

  it("sin empresa, acota el gasto del usuario en el mes", () => {
    expect(decidirUsoIA({ gastoUsuarioSinEmpresaMesUsd: IA_USD_MENSUAL_SIN_EMPRESA - 0.01, operacionesUsuarioHoy: 0 }).ok).toBe(true);
    const d = decidirUsoIA({ gastoUsuarioSinEmpresaMesUsd: IA_USD_MENSUAL_SIN_EMPRESA, operacionesUsuarioHoy: 0 });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.motivo).toBe("sin_empresa");
  });
});

describe("topeMensualEmpresaUsd", () => {
  it("usa el tier propio de la empresa y suma el extra comprado", () => {
    expect(topeMensualEmpresaUsd({ tier: "PRO", duenoEnPrueba: false, extraUsd: 0 })).toBe(iaUsdMensualEmpresa("PRO"));
    expect(topeMensualEmpresaUsd({ tier: "PRO", duenoEnPrueba: false, extraUsd: 10 })).toBe(iaUsdMensualEmpresa("PRO") + 10);
  });

  it("en prueba aplica el techo de prueba, no el del tier", () => {
    expect(topeMensualEmpresaUsd({ tier: "DESPACHO", duenoEnPrueba: true, extraUsd: 0 })).toBe(IA_USD_MENSUAL_PRUEBA);
    expect(IA_USD_MENSUAL_PRUEBA).toBeLessThan(iaUsdMensualEmpresa("ASISTENTE") + 1);
  });

  it("un extra negativo no reduce el techo", () => {
    expect(topeMensualEmpresaUsd({ tier: "ASISTENTE", duenoEnPrueba: false, extraUsd: -5 })).toBe(iaUsdMensualEmpresa("ASISTENTE"));
  });

  it("los techos por tier son crecientes", () => {
    expect(iaUsdMensualEmpresa("ASISTENTE")).toBeLessThan(iaUsdMensualEmpresa("AUTOMATIZADO"));
    expect(iaUsdMensualEmpresa("AUTOMATIZADO")).toBeLessThan(iaUsdMensualEmpresa("PRO"));
    expect(iaUsdMensualEmpresa("PRO")).toBeLessThan(iaUsdMensualEmpresa("DESPACHO"));
  });
});

describe("fechas en hora de México", () => {
  it("periodoActualMx da YYYY-MM y startOfMonthMx cae el día 1 a las 06:00Z", () => {
    const now = new Date("2026-09-15T20:00:00.000Z");
    expect(periodoActualMx(now)).toBe("2026-09");
    expect(startOfMonthMx(now).toISOString()).toBe("2026-09-01T06:00:00.000Z");
  });

  it("startOfDayMx respeta el cambio de día de México (UTC-6)", () => {
    // 03:00Z del día 16 aún es día 15 en México.
    expect(startOfDayMx(new Date("2026-09-16T03:00:00.000Z")).toISOString()).toBe("2026-09-15T06:00:00.000Z");
    expect(startOfDayMx(new Date("2026-09-16T07:00:00.000Z")).toISOString()).toBe("2026-09-16T06:00:00.000Z");
  });
});
