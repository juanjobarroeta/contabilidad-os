import { describe, expect, it } from "vitest";
import { aplicarCorrecciones, armarDocumento, bloquesDeUser, buscarSeccion, encabezadoConDocumento, esquemaComoMarkdown, type Plan } from "./redaccion-estructurada";

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

// El bug que estas pruebas cuidan: el `cache_control` iba en el `system`, que
// aquí son frases de 124 caracteres. Anthropic ignora en silencio los prefijos
// de menos de ~1024 tokens, así que PARECÍA cacheado y no lo estaba. Medido en
// producción: 0 tokens leídos de caché en redacción y revisión, todos los días.
describe("dónde se pide el caché", () => {
  const largo = (n: number) => "x".repeat(n);

  it("un texto suelto va sin punto de caché", () => {
    const b = bloquesDeUser("hola");
    expect(b).toHaveLength(1);
    expect(b[0]).not.toHaveProperty("cache_control");
  });

  it("no lo pide cuando el prefijo no llega al mínimo: sería un gesto vacío", () => {
    const b = bloquesDeUser([{ texto: "Eres un abogado revisor.", cachear: true }, { texto: "el resto" }]);
    expect(b.some((x) => "cache_control" in x)).toBe(false);
  });

  it("lo pide en cuanto el prefijo da el mínimo", () => {
    const b = bloquesDeUser([{ texto: largo(4_000), cachear: true }, { texto: "instrucciones" }]);
    expect(b[0]).toHaveProperty("cache_control");
    expect(b[1]).not.toHaveProperty("cache_control");
  });

  it("gasta dos puntos como mucho: el API sólo admite cuatro y el resto son del system", () => {
    const b = bloquesDeUser([
      { texto: largo(4_000), cachear: true },
      { texto: largo(4_000), cachear: true },
      { texto: largo(4_000), cachear: true },
      { texto: "cola" },
    ]);
    expect(b.filter((x) => "cache_control" in x)).toHaveLength(2);
  });

  it("tira los trozos vacíos, que sólo ensucian el prefijo", () => {
    expect(bloquesDeUser([{ texto: "" }, { texto: "algo" }])).toEqual([{ type: "text", text: "algo" }]);
  });

  it("nunca devuelve un mensaje sin bloques", () => {
    expect(bloquesDeUser([{ texto: "" }])).toHaveLength(1);
  });
});

// De esto depende que la relectura lea de caché lo que escribió la pasada de
// coherencia: si los dos textos no son idénticos byte a byte, no hay prefijo
// compartido y se paga el documento entero dos veces.
describe("el encabezado con el documento", () => {
  const secciones = [{ n: 1, titulo: "Proemio" }, { n: 2, titulo: "Hechos" }];

  it("es el mismo para la coherencia y para la relectura", () => {
    const a = encabezadoConDocumento(secciones, "El documento.");
    const b = encabezadoConDocumento([...secciones], "El documento.");
    expect(a).toBe(b);
    expect(a).toContain("Secciones:");
    expect(a).toContain("[2] Hechos");
    expect(a.endsWith("El documento.")).toBe(true);
  });

  it("corta los documentos enormes en el mismo punto", () => {
    const enorme = "y".repeat(200_000);
    expect(encabezadoConDocumento(secciones, enorme)).toBe(encabezadoConDocumento(secciones, enorme));
    expect(encabezadoConDocumento(secciones, enorme).length).toBeLessThan(121_000);
  });
});
