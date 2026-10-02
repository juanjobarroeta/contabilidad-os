import { describe, expect, it } from "vitest";
import { textoSeguimiento } from "./useChat";

describe("textoSeguimiento (Mochi sigue tras confirmar una tarjeta)", () => {
  it("lleva la tarjeta, el resultado y la instrucción de continuar con el objetivo", () => {
    const t = textoSeguimiento("Registrar préstamo de Juan Barroeta +$21,108.05", "Clasificación guardada como borrador.");
    expect(t).toContain("no lo escribió el usuario");
    expect(t).toContain("préstamo de Juan Barroeta");
    expect(t).toContain("borrador");
    expect(t).toMatch(/prepáralo ahora/);
  });
});
