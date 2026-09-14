import { describe, expect, it } from "vitest";
import { UMBRAL_AVISO, evaluarConsumo, inicioDeMes, periodoDe } from "./consumo";
import { emailValido, generarContrasena, normalizarEmail } from "./usuarios";

describe("consumo del asiento", () => {
  const ahora = new Date("2026-09-14T07:00:00Z");
  const f = [
    { funcion: "ai.juridico", usd: 12.3456, operaciones: 40 },
    { funcion: "ai.juridico.verificacion", usd: 1.2, operaciones: 12 },
    { funcion: "ai.juridico.vision", usd: 3.5, operaciones: 2 },
  ];
  it("redondea a centavos, ordena por gasto y traduce el nombre de la función", () => {
    const c = evaluarConsumo(17.0456, 54, f, ahora, 60);
    expect(c.usd).toBe(17.05);
    expect(c.porFuncion.map((x) => x.funcion)).toEqual(["Consultas y redacción", "Transcripción de escaneos", "Verificación de citas"]);
    expect(c.porFuncion[0].usd).toBe(12.35);
    expect(c.operaciones).toBe(54);
    expect(c.periodo).toBe("2026-09");
  });
  it("avisa al 80 % y marca excedido al llegar al tope", () => {
    expect(evaluarConsumo(40, 1, [], ahora, 60)).toMatchObject({ avisar: false, excedido: false });
    expect(evaluarConsumo(60 * UMBRAL_AVISO, 1, [], ahora, 60)).toMatchObject({ avisar: true, excedido: false });
    expect(evaluarConsumo(60, 1, [], ahora, 60)).toMatchObject({ avisar: false, excedido: true });
    expect(evaluarConsumo(75, 1, [], ahora, 60).fraccion).toBe(1.25);
  });
  it("el mes corre con el huso de México, no con UTC", () => {
    // 1-sep 03:00 UTC son todavía las 21:00 del 31-ago en México.
    expect(periodoDe(new Date("2026-09-01T03:00:00Z"))).toBe("2026-08");
    expect(periodoDe(new Date("2026-09-01T07:00:00Z"))).toBe("2026-09");
    expect(inicioDeMes(new Date("2026-09-14T07:00:00Z")).toISOString()).toBe("2026-09-01T06:00:00.000Z");
  });
});

describe("alta de asientos", () => {
  it("la contraseña temporal evita caracteres que se confunden al dictarla", () => {
    for (let i = 0; i < 40; i++) {
      const c = generarContrasena();
      expect(c).toHaveLength(14);
      expect(c).not.toMatch(/[0O1lI]/);
    }
    expect(new Set([generarContrasena(), generarContrasena(), generarContrasena()]).size).toBe(3);
  });
  it("normaliza el correo y rechaza lo que no es correo", () => {
    expect(normalizarEmail("  Yesenia@Hotmail.COM ")).toBe("yesenia@hotmail.com");
    expect(emailValido("abogada@despacho.mx")).toBe(true);
    expect(emailValido("abogada@despacho")).toBe(false);
    expect(emailValido("sin arroba.mx")).toBe(false);
  });
});
