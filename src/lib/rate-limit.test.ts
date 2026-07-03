import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  checkRateLimit,
  getClientIp,
  resetRateLimiter,
  rateLimiterSize,
} from "./rate-limit";

const MINUTE = 60 * 1000;

describe("checkRateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T12:00:00Z"));
    resetRateLimiter();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("permite intentos por debajo del límite", () => {
    for (let i = 0; i < 5; i++) {
      const res = checkRateLimit("k", { limit: 5, windowMs: 15 * MINUTE });
      expect(res.ok).toBe(true);
      expect(res.retryAfterSeconds).toBeUndefined();
    }
  });

  it("bloquea al exceder el límite e indica retryAfterSeconds", () => {
    for (let i = 0; i < 3; i++) {
      expect(checkRateLimit("k", { limit: 3, windowMs: 15 * MINUTE }).ok).toBe(
        true
      );
    }
    const blocked = checkRateLimit("k", { limit: 3, windowMs: 15 * MINUTE });
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(15 * 60);
  });

  it("mantiene contadores independientes por clave", () => {
    for (let i = 0; i < 3; i++) {
      checkRateLimit("a", { limit: 3, windowMs: MINUTE });
    }
    expect(checkRateLimit("a", { limit: 3, windowMs: MINUTE }).ok).toBe(false);
    expect(checkRateLimit("b", { limit: 3, windowMs: MINUTE }).ok).toBe(true);
  });

  it("los intentos rechazados no cuentan (no extienden el castigo)", () => {
    checkRateLimit("k", { limit: 1, windowMs: 10 * MINUTE });
    // Varios rechazos a mitad de la ventana...
    vi.advanceTimersByTime(5 * MINUTE);
    for (let i = 0; i < 10; i++) {
      expect(checkRateLimit("k", { limit: 1, windowMs: 10 * MINUTE }).ok).toBe(
        false
      );
    }
    // ...y aun así, al expirar el intento original se permite de nuevo.
    vi.advanceTimersByTime(5 * MINUTE);
    expect(checkRateLimit("k", { limit: 1, windowMs: 10 * MINUTE }).ok).toBe(
      true
    );
  });

  it("la ventana es deslizante: libera lugares conforme expiran intentos", () => {
    checkRateLimit("k", { limit: 2, windowMs: 10 * MINUTE }); // t=0
    vi.advanceTimersByTime(6 * MINUTE);
    checkRateLimit("k", { limit: 2, windowMs: 10 * MINUTE }); // t=6min

    const blocked = checkRateLimit("k", { limit: 2, windowMs: 10 * MINUTE });
    expect(blocked.ok).toBe(false);
    // El intento de t=0 expira en 4 minutos.
    expect(blocked.retryAfterSeconds).toBe(4 * 60);

    vi.advanceTimersByTime(4 * MINUTE); // t=10min: expiró el de t=0
    expect(checkRateLimit("k", { limit: 2, windowMs: 10 * MINUTE }).ok).toBe(
      true
    );
  });

  it("al expirar la ventana completa el contador se reinicia", () => {
    for (let i = 0; i < 3; i++) {
      checkRateLimit("k", { limit: 3, windowMs: 15 * MINUTE });
    }
    expect(checkRateLimit("k", { limit: 3, windowMs: 15 * MINUTE }).ok).toBe(
      false
    );

    vi.advanceTimersByTime(15 * MINUTE);
    for (let i = 0; i < 3; i++) {
      expect(checkRateLimit("k", { limit: 3, windowMs: 15 * MINUTE }).ok).toBe(
        true
      );
    }
  });

  it("la limpieza perezosa elimina claves expiradas del Map", () => {
    checkRateLimit("vieja-1", { limit: 5, windowMs: MINUTE });
    checkRateLimit("vieja-2", { limit: 5, windowMs: MINUTE });
    expect(rateLimiterSize()).toBe(2);

    // Más allá de la ventana Y del intervalo de limpieza (10 min).
    vi.advanceTimersByTime(11 * MINUTE);

    // Cualquier verificación dispara el barrido.
    checkRateLimit("nueva", { limit: 5, windowMs: MINUTE });
    expect(rateLimiterSize()).toBe(1);
  });

  it("la limpieza no elimina claves con intentos vigentes", () => {
    checkRateLimit("larga", { limit: 5, windowMs: 60 * MINUTE });
    vi.advanceTimersByTime(11 * MINUTE);
    checkRateLimit("nueva", { limit: 5, windowMs: MINUTE });
    expect(rateLimiterSize()).toBe(2);
  });
});

describe("getClientIp", () => {
  it("toma el primer salto de x-forwarded-for", () => {
    const req = new Request("http://x", {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
    });
    expect(getClientIp(req)).toBe("203.0.113.7");
  });

  it("usa x-real-ip como respaldo", () => {
    const req = new Request("http://x", {
      headers: { "x-real-ip": "198.51.100.4" },
    });
    expect(getClientIp(req)).toBe("198.51.100.4");
  });

  it("regresa una constante sin encabezados", () => {
    const req = new Request("http://x");
    expect(getClientIp(req)).toBe("ip-desconocida");
  });
});
