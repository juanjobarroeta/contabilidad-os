import { describe, expect, it } from "vitest";
import { aplicarCorrecciones, armarDocumento, buscarSeccion, esquemaComoMarkdown, type Plan } from "./redaccion-estructurada";

const plan: Plan = {
  titulo: "Contestación de demanda — exp. 133/2025",
  tipo: "contestacion",
  secciones: [
    { n: 1, titulo: "Proemio", proposito: "Rubro, autoridad, personalidad", markdown: "## Proemio\nC. JUEZ…" },
    { n: 2, titulo: "Contestación a los hechos", proposito: "Hecho por hecho", datos: ["expediente", "partes"], normas: ["CNPCF contestación"] },
    { n: 3, titulo: "Excepciones y defensas", proposito: "Procesales y de fondo", markdown: "## Excepciones y defensas\n1. Falta de acción…" },
  ],
  notas: "Falta la fecha de emplazamiento.",
};

describe("redacción por esquema", () => {
  it("el esquema se ve como Markdown con propósitos, datos, normas y notas", () => {
    const md = esquemaComoMarkdown(plan);
    expect(md).toMatch(/^# Contestación de demanda/);
    expect(md).toMatch(/## 2\. Contestación a los hechos/);
    expect(md).toMatch(/Datos: expediente; partes/);
    expect(md).toMatch(/Normas: CNPCF contestación/);
    expect(md).toMatch(/Falta la fecha de emplazamiento/);
  });
  it("armar marca las secciones pendientes y conserva el orden", () => {
    const doc = armarDocumento(plan);
    expect(doc.indexOf("## Proemio")).toBeLessThan(doc.indexOf("pendiente de redactar"));
    expect(doc).toMatch(/\[Sección 2 «Contestación a los hechos» pendiente/);
    expect(doc).toMatch(/Falta de acción/);
  });
  it("aplicarCorrecciones sustituye sólo secciones existentes con texto real", () => {
    const r = aplicarCorrecciones(plan, [{ n: 3, markdown: "## Excepciones y defensas\n1. Falta de acción\n2. Prescripción" }, { n: 9, markdown: "x".repeat(50) }, { n: 1, markdown: "corto" }]);
    expect(r.aplicadas).toBe(1);
    expect(r.plan.secciones[2].markdown).toMatch(/Prescripción/);
    expect(r.plan.secciones[0].markdown).toMatch(/C\. JUEZ/);
    expect(plan.secciones[2].markdown).not.toMatch(/Prescripción/); // no muta el original
  });
  it("buscarSeccion por número, por texto de número y por título sin acentos", () => {
    expect(buscarSeccion(plan, 2)?.titulo).toBe("Contestación a los hechos");
    expect(buscarSeccion(plan, "3")?.titulo).toBe("Excepciones y defensas");
    expect(buscarSeccion(plan, "excepciones")?.n).toBe(3);
    expect(buscarSeccion(plan, "CONTESTACION A LOS HECHOS")?.n).toBe(2);
    expect(buscarSeccion(plan, "firmas")).toBeUndefined();
  });
});
