import { describe, expect, it } from "vitest";
import { MENSAJE_ACCESO_IA, MENSAJE_SATURADO, MENSAJE_SIN_CREDITO, mensajeDeErrorParaAbogado } from "./errores";
import { conflicto, invalido, noEncontrado, prohibido } from "./errores-api";

describe("mensajeDeErrorParaAbogado", () => {
  it("traduce la cuenta sin crédito (lo que pasó el 13-sep-2026 en prod)", () => {
    const e = new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_x"}');
    expect(mensajeDeErrorParaAbogado(e)).toBe(MENSAJE_SIN_CREDITO);
  });
  it("traduce saturación y llave rechazada", () => {
    expect(mensajeDeErrorParaAbogado(new Error('429 {"type":"error","error":{"type":"rate_limit_error","message":"x"}}'))).toBe(MENSAJE_SATURADO);
    expect(mensajeDeErrorParaAbogado(new Error('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'))).toBe(MENSAJE_SATURADO);
    expect(mensajeDeErrorParaAbogado(new Error('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'))).toBe(MENSAJE_ACCESO_IA);
  });
  it("deja pasar lo que no sabe explicar", () => {
    expect(mensajeDeErrorParaAbogado(new Error("Ya hay un turno en curso en esta conversación; espera a que termine."))).toMatch(/turno en curso/);
    expect(mensajeDeErrorParaAbogado(null)).toBe("Error interno");
  });
});

describe("un dato mal formado no es un conflicto", () => {
  it("400 se corrige en la petición; 409 es el estado del servidor", () => {
    // La app tiene que poder distinguirlos: uno se reintenta cambiando el
    // cuerpo, el otro no se reintenta igual nunca.
    expect(invalido("La fecha va como AAAA-MM-DD.").status).toBe(400);
    expect(conflicto("Ese plazo ya está cumplido.").status).toBe(409);
    expect(noEncontrado("Plazo").status).toBe(404);
    expect(prohibido("Sólo un socio.").status).toBe(403);
  });
});
