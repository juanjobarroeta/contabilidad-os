import { describe, expect, it } from "vitest";
import { esVozFiscalista, parsearResumen, systemPara, textoResumen } from "./resumenes";

describe("parsearResumen", () => {
  it("acepta JSON con o sin texto alrededor y filtra regímenes inválidos", () => {
    const r = parsearResumen('Aquí va:\n{"resumen":"Requisitos que debe reunir toda deducción autorizada para personas morales.","preguntas":["¿Puedo deducir sin factura?","corta"],"regimenes":["601","999","626"]}');
    expect(r?.resumen).toMatch(/^Requisitos/);
    expect(r?.preguntas).toEqual(["¿Puedo deducir sin factura?"]);
    expect(r?.regimenes).toEqual(["601", "626"]);
  });
  it("rechaza basura o resúmenes vacíos", () => {
    expect(parsearResumen("no hay json")).toBeNull();
    expect(parsearResumen('{"resumen":"corto"}')).toBeNull();
    expect(parsearResumen('{"resumen": 5}')).toBeNull();
  });
});

describe("textoResumen", () => {
  it("lleva breadcrumb, cita y preguntas", () => {
    const t = textoResumen("Art. 27 LISR", "TÍTULO II › CAPÍTULO II", { resumen: "De qué trata.", preguntas: ["¿A?", "¿B?"], regimenes: [] });
    expect(t).toBe("[TÍTULO II › CAPÍTULO II]\n[Resumen · Art. 27 LISR]\nDe qué trata.\nResponde a: ¿A? · ¿B?");
  });
  it("sin contexto ni preguntas", () => {
    expect(textoResumen("Regla 2.7.1.32 RMF-2026", null, { resumen: "X.", preguntas: [], regimenes: [] })).toBe("[Resumen · Regla 2.7.1.32 RMF-2026]\nX.");
  });
});

describe("voz del resumen por materia", () => {
  it("fiscal, laboral, aduanero… hablan como fiscalista y etiquetan regímenes", () => {
    expect(esVozFiscalista(["fiscal"])).toBe(true);
    expect(esVozFiscalista(["laboral", "servidores_publicos"])).toBe(true);
    expect(systemPara(["seguridad_social"])).toMatch(/fiscalista/);
    expect(systemPara(["fiscal"])).toMatch(/regimenes.*claves SAT/);
  });
  it("civil, penal, administrativo… hablan como jurista y sin regímenes", () => {
    expect(esVozFiscalista(["civil", "familiar"])).toBe(false);
    expect(esVozFiscalista([])).toBe(false);
    expect(systemPara(["penal", "procesal"])).toMatch(/jurista/);
    expect(systemPara(["civil"])).toMatch(/"regimenes": siempre una lista vacía/);
  });
});
