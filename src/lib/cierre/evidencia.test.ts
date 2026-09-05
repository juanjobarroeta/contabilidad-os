import { describe, it, expect } from "vitest";
import { hashEvidencia, serializarEvidencia } from "./evidencia";

describe("hashEvidencia", () => {
  it("es determinista y no depende del orden de las claves", () => {
    const a = hashEvidencia({ b: 1, a: { y: 2, x: 1 } });
    const b = hashEvidencia({ a: { x: 1, y: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("redondea a centavos y serializa fechas como ISO date", () => {
    expect(serializarEvidencia({ m: 10.004, f: new Date("2026-09-05T13:00:00Z") })).toBe(
      '{"f":"2026-09-05","m":10}'
    );
    expect(hashEvidencia({ m: 10.001 })).toBe(hashEvidencia({ m: 10.004 }));
    expect(hashEvidencia({ m: 10.01 })).not.toBe(hashEvidencia({ m: 10.02 }));
  });

  it("ignora claves undefined y cambia con cualquier cifra", () => {
    expect(hashEvidencia({ a: 1, b: undefined })).toBe(hashEvidencia({ a: 1 }));
    expect(hashEvidencia({ senales: [{ estado: "ok" }] })).not.toBe(hashEvidencia({ senales: [{ estado: "warn" }] }));
  });
});
