import { describe, expect, it } from "vitest";
import { algunaCoincide, extraerCitas, normalizarCita, resumir, type ResultadoPregunta } from "./medidas";
import { PREGUNTAS_EVAL } from "./preguntas";

describe("normalizarCita / algunaCoincide", () => {
  it("empata variantes de escritura del mismo artículo", () => {
    expect(normalizarCita("artículo 27 de la LISR")).toBe("ART. 27 LISR");
    expect(algunaCoincide(["Art. 27 LISR"], ["Art. 5 LIVA", "ART 27 LISR"])).toBe(true);
    expect(algunaCoincide(["Art. 27 LISR"], ["Art. 28 LISR"])).toBe(false);
  });
  it("una regla empata sin el año de la RMF", () => {
    expect(algunaCoincide(["Regla 2.7.1.32 RMF-2026"], ["Regla 2.7.1.32 RMF"])).toBe(true);
  });
});

describe("extraerCitas", () => {
  it("saca artículos y reglas del texto de una respuesta", () => {
    const t = "Según el artículo 27, fracción III de la LISR y el Art. 1-B LIVA; ver Regla 2.7.1.32 de la RMF y art 17-H Bis del CFF.";
    expect([...extraerCitas(t)].sort()).toEqual(["ART. 1-B LIVA", "ART. 17-H BIS CFF", "ART. 27 LISR", "REGLA 2.7.1.32 RMF"]);
  });
  it("no encuentra nada en una respuesta sin fundamento", () => {
    expect(extraerCitas("No encontré fundamento suficiente.")).toEqual([]);
  });
});

describe("resumir", () => {
  it("porcentajes sobre las preguntas sin error; null en capas que no corrieron", () => {
    const rs: ResultadoPregunta[] = [
      { id: "a", tema: "t", pregunta: "p", fundamentos: [], recuperacion: { hit: true, citas: [] } },
      { id: "b", tema: "t", pregunta: "p", fundamentos: [], recuperacion: { hit: false, citas: [] } },
      { id: "c", tema: "t", pregunta: "p", fundamentos: [], recuperacion: { hit: false, citas: [] }, error: "boom" },
    ];
    const r = resumir(rs);
    expect(r.n).toBe(3);
    expect(r.conError).toBe(1);
    expect(r.recuperacionHit).toBe(50);
    expect(r.citaPresente).toBeNull();
    expect(r.fundamentoCorrecto).toBeNull();
  });
});

describe("PREGUNTAS_EVAL", () => {
  it("ids únicos y fundamentos en el formato de buildCita", () => {
    const ids = new Set(PREGUNTAS_EVAL.map((p) => p.id));
    expect(ids.size).toBe(PREGUNTAS_EVAL.length);
    for (const p of PREGUNTAS_EVAL) {
      expect(p.fundamentos.length).toBeGreaterThan(0);
      for (const f of p.fundamentos) expect(f).toMatch(/^(Art\. \S+( Bis)? (LISR|LIVA|CFF|LIEPS)|Regla \d+(\.\d+)+ RMF-\d{4})$/);
    }
  });
});
