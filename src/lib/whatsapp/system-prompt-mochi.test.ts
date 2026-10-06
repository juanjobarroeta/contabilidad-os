import { describe, expect, it } from "vitest";
import { buildWhatsappSystemPrompt } from "./system-prompt";

const empresa = { rfc: "AAA010101AAA", razonSocial: "Prueba", regimenFiscal: "601", codigoPostal: "72000" };

describe("WhatsApp: el mismo copiloto que en la app", () => {
  it("usa el nombre y el tono que eligió la persona", () => {
    const p = buildWhatsappSystemPrompt(empresa, undefined, { nombre: "Lupa", tono: "calma", entidades: ["PUE", "JAL"] });
    expect(p).toContain("Eres Lupa, el copiloto contable de Contabilidad OS");
    expect(p).toContain("sin tecnicismos");
    expect(p).toContain("Estados donde opera: PUE, JAL");
    expect(p).not.toContain("Eres el contador virtual");
  });

  it("trae el método del contador y la memoria compartida", () => {
    const p = buildWhatsappSystemPrompt(empresa);
    expect(p).toContain("Piensa como contador");
    expect(p).toContain("Depósito recibido por error / a devolver");
    expect(p).toContain("Memoria compartida con la app");
  });
});
