import { describe, it, expect } from "vitest";
import { decideWhatsappRateLimit } from "./rate-limit";

const PRO = { dailyMsgsPerUser: 40, monthlyLlmUsd: 5 };

describe("decideWhatsappRateLimit", () => {
  it("permite el turno cuando está por debajo de ambos topes", () => {
    const d = decideWhatsappRateLimit({ dailyCount: 10, monthlyLlmUsd: 1.5, limits: PRO });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBeUndefined();
  });

  it("bloquea por tope diario al alcanzar el límite por usuario", () => {
    const d = decideWhatsappRateLimit({ dailyCount: 40, monthlyLlmUsd: 0, limits: PRO });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("daily_user");
    expect(d.mensaje).toMatch(/límite de consultas por hoy/i);
  });

  it("bloquea por presupuesto mensual al superar el USD de la empresa", () => {
    const d = decideWhatsappRateLimit({ dailyCount: 5, monthlyLlmUsd: 5, limits: PRO });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("monthly_company");
    expect(d.mensaje).toMatch(/límite de uso del asistente este mes/i);
  });

  it("reporta primero el tope diario cuando se incumplen ambos", () => {
    const d = decideWhatsappRateLimit({ dailyCount: 100, monthlyLlmUsd: 99, limits: PRO });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("daily_user");
  });

  it("un tier sin WhatsApp (límites 0) bloquea siempre", () => {
    const d = decideWhatsappRateLimit({
      dailyCount: 0,
      monthlyLlmUsd: 0,
      limits: { dailyMsgsPerUser: 0, monthlyLlmUsd: 0 },
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("daily_user");
  });

  it("permite justo por debajo del tope diario (límite - 1)", () => {
    const d = decideWhatsappRateLimit({ dailyCount: 39, monthlyLlmUsd: 4.99, limits: PRO });
    expect(d.allowed).toBe(true);
  });
});
