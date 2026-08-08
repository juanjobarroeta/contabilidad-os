import { describe, it, expect } from "vitest";
import {
  errorRegistroPatronal,
  normalizarRegistroPatronal,
  registroPatronalEfectivo,
  registroPatronalValido,
} from "./registro-patronal";

describe("normalizarRegistroPatronal", () => {
  it("sube a mayúsculas y quita espacios, guiones y puntos", () => {
    expect(normalizarRegistroPatronal("a70 25105 10-3")).toBe("A7025105103");
    expect(normalizarRegistroPatronal("A70.25105.103")).toBe("A7025105103");
  });

  it("vacío o sólo espacios da null", () => {
    expect(normalizarRegistroPatronal("")).toBeNull();
    expect(normalizarRegistroPatronal("   ")).toBeNull();
    expect(normalizarRegistroPatronal(null)).toBeNull();
    expect(normalizarRegistroPatronal(undefined)).toBeNull();
  });
});

describe("registroPatronalValido", () => {
  it("acepta 11 alfanuméricos, con o sin separadores de captura", () => {
    expect(registroPatronalValido("A7025105103")).toBe(true);
    expect(registroPatronalValido("a70 25105 10 3")).toBe(true);
    expect(registroPatronalValido("Y6123456789")).toBe(true);
  });

  it("rechaza largos incorrectos y caracteres raros", () => {
    expect(registroPatronalValido("A702510510")).toBe(false); // 10
    expect(registroPatronalValido("A70251051034")).toBe(false); // 12
    expect(registroPatronalValido("")).toBe(false);
  });

  it("rechaza un correo electrónico (caso real: se guardó uno sin aviso)", () => {
    expect(registroPatronalValido("JESUS.VERDIGUEL@GRUPOASTURCAR.COM")).toBe(false);
  });
});

describe("errorRegistroPatronal", () => {
  it("un valor válido y el vacío no dan error (vacío = sin capturar)", () => {
    expect(errorRegistroPatronal("A7025105103")).toBeNull();
    expect(errorRegistroPatronal("a70 25105 10-3")).toBeNull();
    expect(errorRegistroPatronal("")).toBeNull();
    expect(errorRegistroPatronal(null)).toBeNull();
  });

  it("detecta el correo electrónico y lo dice con esas palabras", () => {
    expect(errorRegistroPatronal("JESUS.VERDIGUEL@GRUPOASTURCAR.COM")).toContain("correo electrónico");
  });

  it("el error de largo dice cuántos capturaste", () => {
    const e = errorRegistroPatronal("A70251051")!;
    expect(e).toContain("11 caracteres");
    expect(e).toContain("capturaste 9");
  });

  it("caracteres no alfanuméricos dan su propio mensaje", () => {
    expect(errorRegistroPatronal("A70#5105103")).toContain("letras y números");
  });
});

describe("registroPatronalEfectivo", () => {
  const empresa = { registroPatronal: "A7025105103" };

  it("el del empleado gana (empresa multi-estado: un registro por centro)", () => {
    expect(
      registroPatronalEfectivo({ registroPatronal: "B8136216214" }, empresa)
    ).toBe("B8136216214");
  });

  it("sin registro propio cae al de la empresa", () => {
    expect(registroPatronalEfectivo({ registroPatronal: null }, empresa)).toBe("A7025105103");
    expect(registroPatronalEfectivo({}, empresa)).toBe("A7025105103");
  });

  it("normaliza ambos lados", () => {
    expect(
      registroPatronalEfectivo({ registroPatronal: " b81 36216 21-4 " }, empresa)
    ).toBe("B8136216214");
  });

  it("sin ninguno de los dos devuelve null", () => {
    expect(registroPatronalEfectivo({}, { registroPatronal: null })).toBeNull();
  });
});
