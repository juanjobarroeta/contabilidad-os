import { describe, it, expect } from "vitest";
import { prefijoDeCodigo, reglaDeSerie, type ReglaSerie } from "./serie-cuenta";

const cta = (cuentaSAT: string): ReglaSerie["cuenta"] => ({ id: cuentaSAT, cuentaSAT, nombre: cuentaSAT });
const REGLAS: ReglaSerie[] = [
  { prefijo: "NCA", cuenta: cta("4501-0008-0000") },
  { prefijo: "NCAZ", cuenta: cta("4501-0001-0000") },
  { prefijo: "SM", cuenta: cta("4291-0001-0000") },
];

describe("prefijoDeCodigo()", () => {
  it("lee el prefijo y lo normaliza", () => {
    expect(prefijoDeCodigo("serie:NCA")).toBe("NCA");
    expect(prefijoDeCodigo("serie: sm ")).toBe("SM");
  });

  it("un código de agrupador normal no es regla de serie", () => {
    expect(prefijoDeCodigo("601.48")).toBeNull();
    expect(prefijoDeCodigo("serie:")).toBeNull();
  });
});

describe("reglaDeSerie()", () => {
  it("empata por prefijo: NCAA cae en la regla NCA", () => {
    expect(reglaDeSerie("NCAA", REGLAS)?.cuenta.cuentaSAT).toBe("4501-0008-0000");
  });

  it("el prefijo más largo gana: NCAZ tiene su propia cuenta", () => {
    expect(reglaDeSerie("NCAZ", REGLAS)?.cuenta.cuentaSAT).toBe("4501-0001-0000");
  });

  it("no distingue mayúsculas ni espacios del origen", () => {
    expect(reglaDeSerie(" smz ", REGLAS)?.cuenta.cuentaSAT).toBe("4291-0001-0000");
  });

  it("una serie sin regla no resuelve — y sin serie tampoco", () => {
    expect(reglaDeSerie("NVS", REGLAS)).toBeNull();
    expect(reglaDeSerie("", REGLAS)).toBeNull();
    expect(reglaDeSerie(null, REGLAS)).toBeNull();
  });

  it("sin reglas cargadas el motor no cambia de conducta", () => {
    expect(reglaDeSerie("NCA", [])).toBeNull();
  });
});
