import { describe, expect, it } from "vitest";
import { algunaCoincide, extraerCitas, normalizarCita, resumir, valoresPresentes, type ResultadoPregunta } from "./medidas";
import { PREGUNTAS_EVAL } from "./preguntas";

describe("normalizarCita / algunaCoincide", () => {
  it("empata variantes de escritura del mismo artículo", () => {
    expect(normalizarCita("artículo 27 de la LISR")).toBe("ART. 27 LISR");
    expect(algunaCoincide(["Art. 27 LISR"], ["Art. 5 LIVA", "ART 27 LISR"])).toBe(true);
    expect(algunaCoincide(["Art. 27 LISR"], ["Art. 28 LISR"])).toBe(false);
  });
  it("el ordinal de LIVA/CFF («5o», «2o.-A») empata con la forma sin ordinal", () => {
    expect(normalizarCita("Art. 5o LIVA")).toBe("ART. 5 LIVA");
    expect(normalizarCita("Art. 2o.-A LIVA")).toBe("ART. 2-A LIVA");
    expect(algunaCoincide(["Art. 5 LIVA"], ["Art. 5o LIVA"])).toBe(true);
    expect(algunaCoincide(["Art. 2-A LIVA"], ["Art. 2o.-A LIVA"])).toBe(true);
    // «10» no es «1o»: el ordinal sólo se quita cuando es la letra O.
    expect(normalizarCita("Art. 10 LISR")).toBe("ART. 10 LISR");
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
      for (const f of p.fundamentos) expect(f).toMatch(/^(Art\. \S+( Bis)? (RLISR|RLIVA|RCFF|LISR|LIVA|CFF|LIEPS|LSS|LINFONAVIT|LFT)|Regla \d+(\.\d+)+ RMF-\d{4})$/);
    }
  });
});

describe("normalizarCita — fracciones", () => {
  it("quita la fracción romana pegada al número; conserva letras reales de artículo", () => {
    expect(normalizarCita("Art. 27-III LISR")).toBe("ART. 27 LISR");
    expect(normalizarCita("Art. 28-XXXII LISR")).toBe("ART. 28 LISR");
    expect(normalizarCita("Art. 28-V LISR")).toBe("ART. 28 LISR");
    expect(normalizarCita("Art. 162-III LFT")).toBe("ART. 162 LFT");
    expect(normalizarCita("Art. 17-L CFF")).toBe("ART. 17-L CFF");
    expect(normalizarCita("Art. 18-I LIVA")).toBe("ART. 18-I LIVA");
    expect(normalizarCita("Art. 113-E LISR")).toBe("ART. 113-E LISR");
  });
  it("una cita con fracción ya no cuenta como fuera de la KB", () => {
    expect(algunaCoincide(["Art. 27 LISR"], ["Art. 27-III LISR"])).toBe(true);
  });
});

describe("valoresPresentes", () => {
  it("tolera $ , espacios, decimales y porcentajes; exige TODOS los esperados", () => {
    expect(valoresPresentes("La multa va de $2,050.00 a $25,360.00 (Art. 82 CFF).", [2050, 25360])).toBe(true);
    expect(valoresPresentes("UMA diaria 117.31 y mensual 3 566.22 pesos", [117.31, 3566.22])).toBe(true);
    expect(valoresPresentes("la tasa de recargos es 2.07% mensual", [2.07])).toBe(true);
    expect(valoresPresentes("la tasa de recargos es 1.47 % mensual", [2.07])).toBe(false);
    expect(valoresPresentes("de $2,050 a $25,000", [2050, 25360])).toBe(false);
  });
});
