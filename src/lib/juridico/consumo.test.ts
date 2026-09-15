import { describe, expect, it } from "vitest";
import { UMBRAL_AVISO, evaluarConsumo, inicioDeMes, periodoDe } from "./consumo";
import { emailValido, generarContrasena, normalizarEmail } from "./usuarios";

describe("consumo del asiento", () => {
  const ahora = new Date("2026-09-14T07:00:00Z");
  const f = [
    { funcion: "ai.juridico", usd: 12.3456, operaciones: 40 },
    { funcion: "ai.juridico.verificacion", usd: 1.2, operaciones: 12 },
    { funcion: "ai.juridico.vision", usd: 3.0, operaciones: 1 },
    { funcion: "ai.juridico.ocr", usd: 0.5, operaciones: 1 },
  ];
  it("redondea a centavos, ordena por gasto y traduce el nombre de la función", () => {
    const c = evaluarConsumo(17.0456, 54, f, ahora, 60);
    expect(c.usd).toBe(17.05);
    expect(c.porFuncion.map((x) => x.funcion)).toEqual(["Consultas del chat", "Transcripción de escaneos", "Verificación de citas"]);
    expect(c.porFuncion[0].usd).toBe(12.35);
    expect(c.operaciones).toBe(54);
    // vision y ocr son lo mismo para el abogado: un renglón, sumados.
    const transcripcion = c.porFuncion.find((x) => x.funcion === "Transcripción de escaneos")!;
    expect(transcripcion).toMatchObject({ usd: 3.5, operaciones: 2 });
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

describe("el tope por default", () => {
  it("son 120 USD: con uso real, 60 frenaba a quien estaba trabajando", async () => {
    const { TOPE_MENSUAL_USD } = await import("./consumo");
    expect(TOPE_MENSUAL_USD).toBe(120);
    // Una abogada trabajando (37 USD medidos) no se acerca al aviso.
    expect(evaluarConsumo(37, 180, [], new Date("2026-09-14T12:00:00Z"), TOPE_MENSUAL_USD)).toMatchObject({ avisar: false, excedido: false });
    // Una jornada intensa de redacción (64 USD medidos) tampoco.
    expect(evaluarConsumo(64, 200, [], new Date("2026-09-14T12:00:00Z"), TOPE_MENSUAL_USD)).toMatchObject({ avisar: false, excedido: false });
  });
});
