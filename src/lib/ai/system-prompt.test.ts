import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./system-prompt";

const empresa = { rfc: "AAA010101AAA", razonSocial: "Prueba", regimenFiscal: "601", codigoPostal: "72000" };

describe("prompt del copiloto: reglas operativas del CFDI", () => {
  // Generation/certification and cash-basis IVA are different legal clocks.
  const p = buildSystemPrompt(empresa);
  it("sabe que la Fecha del CFDI puede ser hasta 72 h anterior al timbrado", () => {
    expect(p).toMatch(/72 h/);
    expect(p).toMatch(/Fecha del CFDI/);
  });
  it("cobro recibido antes de emitir: PUE con IVA en el mes del cobro", () => {
    expect(p).toMatch(/Cobro recibido antes de emitir/);
    expect(p).toMatch(/mes del cobro/);
  });
  it("cita las reglas y evita inventar fechas o declarar una estimación", () => {
    expect(p).toMatch(/TODAS las opciones válidas/);
    expect(p).toContain("RMF 2.7.2.9-I");
    expect(p).toContain("RCFF 39");
    expect(p).toContain("NO pago → emisión");
    expect(p).toContain("no inventes las 23:59");
    expect(p).toContain("determinado=false");
    expect(p).not.toContain("Esto no viene en las leyes");
    expect(p).not.toContain("recomienda fecharlo en el mes del cobro");
    expect(p).toContain("Art. 18-A");
    expect(p).toContain("query_iva_cobro");
    expect(p).toContain("proponer_revision_iva_cobro");
    expect(p).not.toContain("IVA → Revisar cobro");
  });
});

describe("prompt del copiloto: estados donde opera", () => {
  it("lista domicilio y sucursales cuando se conocen", () => {
    const p = buildSystemPrompt({ ...empresa, entidades: ["PUE", "JAL"] });
    expect(p).toContain("**Estados donde opera:** PUE, JAL");
    expect(p).toContain("cada estado cobra su ISN por separado");
  });

  it("sin entidades no agrega la línea", () => {
    expect(buildSystemPrompt(empresa)).not.toContain("Estados donde opera");
  });
});
