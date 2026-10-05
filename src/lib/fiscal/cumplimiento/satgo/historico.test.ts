import { describe, expect, it } from "vitest";
import { ejerciciosConHuecos, esErrorDeSuscripcion } from "./historico";
import { SatGoError } from "./client";

const hoy = new Date(2026, 9, 5); // 5-oct-2026
const obligadas = new Set(["IVA_MENSUAL", "ISR_PROVISIONAL"]);
const completo = (ejercicio: number, meses: number[]) => meses.flatMap((m) => [...obligadas].map((t) => `${t}:${ejercicio}-${String(m).padStart(2, "0")}`));

describe("ejerciciosConHuecos", () => {
  it("empresa nueva en 2026 con 3 años pedidos: sólo 2026, acotado al inicio de operaciones", () => {
    const r = ejerciciosConHuecos({ hoy, anios: 3, inicio: new Date(2026, 7, 14), obligadas, have: new Set() });
    expect(r).toEqual([{ ejercicio: 2026, meses: 2, completos: 0 }]); // ago y sep cerrados; oct en curso
  });

  it("un ejercicio con todos sus meses obligados presentes no se pide", () => {
    const have = new Set([...completo(2026, [1, 2, 3, 4, 5, 6, 7, 8, 9]), ...completo(2025, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])]);
    const r = ejerciciosConHuecos({ hoy, anios: 2, inicio: null, obligadas, have });
    expect(r.map((e) => e.ejercicio)).toEqual([2024]);
  });

  it("falta UN mes de un ejercicio → se pide ese ejercicio; el más reciente primero", () => {
    const have = new Set([...completo(2026, [1, 2, 3, 4, 5, 6, 7, 8]), ...completo(2025, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12])]);
    const r = ejerciciosConHuecos({ hoy, anios: 2, inicio: null, obligadas, have });
    expect(r.map((e) => `${e.ejercicio}:${e.completos}/${e.meses}`)).toEqual(["2026:8/9", "2025:11/12", "2024:0/3"]);
  });

  it("sin obligaciones mensuales no hay nada que pedir", () => {
    expect(ejerciciosConHuecos({ hoy, anios: 5, inicio: null, obligadas: new Set(), have: new Set() })).toEqual([]);
  });
});

describe("esErrorDeSuscripcion", () => {
  it("reconoce el 403 de SatGo por suscripción", () => {
    expect(esErrorDeSuscripcion(new SatGoError('SatGo decfiel 2025-0 403: {"message":"La suscripción requiere actualización de estado"}', 403))).toBe(true);
    expect(esErrorDeSuscripcion(new SatGoError("SatGo decfiel 400: Certificado inválido", 400))).toBe(false);
  });
});
