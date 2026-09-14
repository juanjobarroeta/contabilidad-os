import { describe, expect, it } from "vitest";
import { clasificarFalloIa } from "./ia-salud";

describe("clasificarFalloIa", () => {
  it("saldo agotado y llave rechazada despiertan a alguien", () => {
    const saldo = clasificarFalloIa(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'));
    expect(saldo).toMatchObject({ causa: "sin-credito", alertar: true });
    expect(clasificarFalloIa(new Error('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'))).toMatchObject({ causa: "llave-rechazada", alertar: true });
  });
  it("saturación y red se resuelven solas: no alertan", () => {
    expect(clasificarFalloIa(new Error('429 {"type":"error","error":{"type":"rate_limit_error"}}'))).toMatchObject({ causa: "saturado", alertar: false });
    expect(clasificarFalloIa(new Error('529 {"type":"error","error":{"type":"overloaded_error"}}'))).toMatchObject({ causa: "saturado", alertar: false });
    expect(clasificarFalloIa(new Error("fetch failed (UND_ERR_CONNECT_TIMEOUT)"))).toMatchObject({ causa: "red", alertar: false });
  });
  it("lo desconocido alerta, y el detalle se recorta", () => {
    const r = clasificarFalloIa(new Error("x".repeat(500)));
    expect(r.causa).toBe("otro");
    expect(r.alertar).toBe(true);
    expect(r.detalle).toHaveLength(200);
  });
});
