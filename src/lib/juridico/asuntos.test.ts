import { describe, expect, it } from "vitest";
import { bloqueAsuntoParaPrompt, fusionarParte, mismaParte, normalizarCurp, normalizarNombre, normalizarRfc, type Asunto, type Parte } from "./asuntos";

describe("partes: normalización y fusión", () => {
  it("RFC y CURP se normalizan y se validan por forma", () => {
    expect(normalizarRfc(" xaxx-010101-000 ")).toBe("XAXX010101000");
    expect(normalizarRfc("ACME 010101 AB1")).toBe("ACME010101AB1");
    expect(normalizarRfc("no es rfc")).toBeNull();
    expect(normalizarCurp("peep 900101 hdfrrd09")).toBe("PEEP900101HDFRRD09");
    expect(normalizarCurp("PEEP900101")).toBeNull();
  });
  it("misma parte por RFC, por CURP o por nombre sin acentos ni forma societaria", () => {
    expect(mismaParte({ nombre: "ACME, S.A. de C.V.", rfc: "ACM010101AB1" }, { nombre: "Acme SA de CV", rfc: "acm-010101-ab1" })).toBe(true);
    expect(mismaParte({ nombre: "Pedro Estrada Chávez" }, { nombre: "PEDRO ESTRADA CHAVEZ" })).toBe(true);
    expect(mismaParte({ nombre: "Pedro Estrada", rfc: "PEEP900101AB1" }, { nombre: "Pedro Estrada", rfc: "PEEP900102AB1" })).toBe(false);
    expect(normalizarNombre("ACME, S.A. DE C.V.")).toBe("acme");
  });
  it("fusionar completa huecos sin pisar lo verificado a mano; lo no verificado sí se actualiza", () => {
    const manual: Parte = { rol: "actor", tipoPersona: "fisica", nombre: "Paulina Estrada Morales", rfc: null, curp: null, fuente: "manual", verificado: true };
    const f = fusionarParte(manual, { nombre: "PAULINA ESTRADA", rfc: "EAMP000101AB1", rol: "demandada", fuente: "documento" });
    expect(f.nombre).toBe("Paulina Estrada Morales");
    expect(f.rol).toBe("actor");
    expect(f.rfc).toBe("EAMP000101AB1");
    const chat: Parte = { rol: "parte", tipoPersona: "fisica", nombre: "Pedro Estrada", fuente: "chat", verificado: false };
    const g = fusionarParte(chat, { rol: "demandado", domicilio: "Calle 1", fuente: "documento", rfc: "" });
    expect(g.rol).toBe("demandado");
    expect(g.domicilio).toBe("Calle 1");
    expect(g.fuente).toBe("documento");
  });
});

describe("bloqueAsuntoParaPrompt", () => {
  it("sin asunto: instrucción de registrar; con asunto: partes, cliente, objetivo y decisiones marcando lo no verificado", () => {
    expect(bloqueAsuntoParaPrompt(null)).toMatch(/aún no tiene asunto/);
    const a: Asunto = {
      id: "a1", titulo: "Pensión alimenticia 133/2025", materia: "familiar", via: "juicio oral familiar", autoridad: "Juzgado Primero Familiar por Audiencias", expediente: "133/2025", entidad: "CHH", cliente: "demandado: Pedro Estrada", objetivo: "Reducir la pensión a un monto proporcional",
      decisiones: [{ texto: "No reconvenir", fecha: "2026-09-13" }],
      partes: [{ rol: "actor", tipoPersona: "fisica", nombre: "Paulina Estrada", fuente: "documento", verificado: false }, { rol: "demandado", tipoPersona: "fisica", nombre: "Pedro Estrada", rfc: "EACP700101AB1", fuente: "manual", verificado: true }],
    };
    const b = bloqueAsuntoParaPrompt(a);
    expect(b).toMatch(/expediente 133\/2025/);
    expect(b).toMatch(/actor: \*\*Paulina Estrada\*\* .* — sin verificar/);
    expect(b).toMatch(/demandado: \*\*Pedro Estrada\*\* \(persona física, RFC EACP700101AB1\)$/m);
    expect(b).toMatch(/No reconvenir/);
    expect(b).toMatch(/NUNCA lo inventes/);
  });
});
