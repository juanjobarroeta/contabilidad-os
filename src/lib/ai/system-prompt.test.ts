import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./system-prompt";

const empresa = { rfc: "AAA010101AAA", razonSocial: "Prueba", regimenFiscal: "601", codigoPostal: "72000" };

describe("prompt del copiloto: reglas operativas del CFDI", () => {
  // Caso real (oct-2026): un cobro de septiembre sin CFDI. El copiloto dijo
  // «emítela PUE en octubre»; el contador, «fechada en septiembre» (cabía en
  // las 72 h). La regla no está en las leyes: tiene que venir en el prompt.
  const p = buildSystemPrompt(empresa);
  it("sabe que la Fecha del CFDI puede ser hasta 72 h anterior al timbrado", () => {
    expect(p).toMatch(/72 h/);
    expect(p).toMatch(/Fecha del CFDI/);
  });
  it("cobro recibido antes de emitir: PUE, y fechar en el mes del cobro si cabe", () => {
    expect(p).toMatch(/Cobro recibido antes de emitir/);
    expect(p).toMatch(/mes del cobro/);
  });
  it("pide dar todas las opciones válidas, incluida la de fechar atrás", () => {
    expect(p).toMatch(/TODAS las opciones válidas/);
  });
});
