import { describe, expect, it } from "vitest";
import { leerClabe } from "./clabe";

describe("bank CLABE input", () => {
  it("accepts the published Banamex example, retaining leading zeroes", () => {
    expect(leerClabe("002 115 01600326941 1")).toEqual({ ok: true, clabe: "002115016003269411" });
  });
  it.each(["123", "002115016003269412", "00211501600326941X", 2115016003269411])("rejects invalid input %s", (v) => {
    expect(leerClabe(v).ok).toBe(false);
  });
  it.each([undefined, null, "", " "])("allows omitted CLABE %s", (v) => {
    expect(leerClabe(v)).toEqual({ ok: true, clabe: null });
  });
});
