import { describe, it, expect } from "vitest";
import { dedupeKey } from "./service";

describe("dedupeKey", () => {
  it("usa dedupeRef estable cuando el check lo fija", () => {
    expect(dedupeKey({ checkClave: "x", dedupeRef: "x", referencias: ["a", "b"] })).toBe("x|x");
  });

  it("identidades cortas quedan legibles (ids ordenados)", () => {
    expect(dedupeKey({ checkClave: "x", referencias: ["b", "a"] })).toBe("x|a,b");
  });

  it("compacta a hash las identidades largas (el índice btree rechaza filas > ~2.7 KB)", () => {
    // Caso real: cientos de depósitos sin conciliar → dedupeKey de 5.7 KB →
    // "index row size exceeds btree maximum" y la corrida de auditoría muerta.
    const referencias = Array.from({ length: 300 }, (_, i) => `cmref${String(i).padStart(20, "0")}`);
    const key = dedupeKey({ checkClave: "banco.ingreso_no_facturado", referencias });
    expect(key.length).toBeLessThan(120);
    expect(key).toMatch(/^banco\.ingreso_no_facturado\|sha256:[0-9a-f]{64}$/);
    // Estable: mismas referencias (en otro orden) → misma llave.
    expect(dedupeKey({ checkClave: "banco.ingreso_no_facturado", referencias: [...referencias].reverse() })).toBe(key);
  });
});
