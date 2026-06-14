import { describe, it, expect } from "vitest";
import { esBajoAgua } from "./rentabilidad";

describe("esBajoAgua (cliente cuyo costo supera su precio)", () => {
  it("is true only when there's a positive price the cost exceeds", () => {
    expect(esBajoAgua(10_000, 12_000)).toBe(true); // precio $100, costo $120
    expect(esBajoAgua(10_000, 9_000)).toBe(false); // rentable
    expect(esBajoAgua(10_000, 10_000)).toBe(false); // empata, no es pérdida
  });
  it("is false when there's no price set or price is zero", () => {
    expect(esBajoAgua(null, 5_000)).toBe(false);
    expect(esBajoAgua(0, 5_000)).toBe(false);
  });
});
