import { describe, expect, it } from "vitest";
import { MENSAJE_ACCESO_IA, MENSAJE_SATURADO, MENSAJE_SIN_CREDITO, mensajeDeErrorParaAbogado } from "./errores";

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
