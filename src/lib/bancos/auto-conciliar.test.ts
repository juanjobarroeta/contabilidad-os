import { describe, it, expect } from "vitest";
import {
  scoreCandidate,
  isAutoApplicable,
  AUTO_MATCH_MIN_SCORE,
  AUTO_MATCH_AMBIGUITY_GAP,
} from "./auto-conciliar";

const tx = { fecha: new Date("2026-06-10T00:00:00Z"), descripcion: "SPEI RECIBIDO" };

describe("scoreCandidate (misma fórmula que el match route)", () => {
  it("monto exacto + fecha ≤1d = 130 (umbral de auto-aplicación)", () => {
    const inv = { total: 1000, fecha: new Date("2026-06-10T00:00:00Z"), customerRfc: null };
    expect(scoreCandidate(inv, tx, 1000)).toBe(130); // 100 (exacto) + 30 (≤1d)
  });

  it("monto exacto + fecha a 5d = 110 (no alcanza el umbral)", () => {
    const inv = { total: 1000, fecha: new Date("2026-06-05T00:00:00Z"), customerRfc: null };
    expect(scoreCandidate(inv, tx, 1000)).toBe(110); // 100 + 10 (≤7d)
  });

  it("suma 25 cuando el RFC aparece en la descripción", () => {
    const inv = {
      total: 1000,
      fecha: new Date("2026-06-10T00:00:00Z"),
      customerRfc: "XAXX010101000",
    };
    const txConRfc = { ...tx, descripcion: "SPEI XAXX010101000 PAGO" };
    expect(scoreCandidate(inv, txConRfc, 1000)).toBe(155); // 100 + 30 + 25
  });

  it("diferencia <0.5% suma 70, no 100", () => {
    const inv = { total: 1003, fecha: new Date("2026-06-10T00:00:00Z"), customerRfc: null };
    expect(scoreCandidate(inv, tx, 1000)).toBe(100); // 70 (<0.5%) + 30 (≤1d)
  });
});

describe("isAutoApplicable (umbral exacto, sin cambios)", () => {
  it("exige score ≥ 130", () => {
    expect(AUTO_MATCH_MIN_SCORE).toBe(130);
    expect(isAutoApplicable(129, null)).toBe(false);
    expect(isAutoApplicable(130, null)).toBe(true);
  });

  it("rechaza cuando el 2° candidato está a <20 puntos (ambiguo)", () => {
    expect(AUTO_MATCH_AMBIGUITY_GAP).toBe(20);
    expect(isAutoApplicable(155, 140)).toBe(false); // gap 15 < 20
    expect(isAutoApplicable(155, 135)).toBe(true); // gap 20
  });

  it("aplica cuando no hay 2° candidato y el score alcanza el umbral", () => {
    expect(isAutoApplicable(130, null)).toBe(true);
  });
});
