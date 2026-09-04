import { describe, expect, it } from "vitest";
import { clasificarCitas, fraccionesMencionadas, fuentesDesdeToolResult, motivoRechazoCorreccion, parsearCita, parsearVeredicto, seleccionarTexto } from "./verificacion";

describe("clasificarCitas", () => {
  it("una cita con fracción o con año de RMF cuenta como sostenida si la KB la devolvió", () => {
    const r = clasificarCitas(["ART. 27-III LISR", "REGLA 2.7.1.32 RMF", "ART. 29-A CFF"], ["Art. 27 LISR", "Regla 2.7.1.32 RMF-2026"]);
    expect(r.sostenidas).toEqual(["ART. 27-III LISR", "REGLA 2.7.1.32 RMF"]);
    expect(r.faltantes).toEqual(["ART. 29-A CFF"]);
  });
});

describe("parsearCita", () => {
  it("artículos con sufijo, Bis y reglas", () => {
    expect(parsearCita("ART. 27 LISR")).toEqual({ clave: "LISR", articulo: "27" });
    expect(parsearCita("ART. 29-A CFF")).toEqual({ clave: "CFF", articulo: "29-A" });
    expect(parsearCita("ART. 17-H BIS CFF")).toEqual({ clave: "CFF", articulo: "17-H Bis" });
    expect(parsearCita("REGLA 2.7.1.32 RMF-2026")).toEqual({ clave: "RMF", articulo: "2.7.1.32" });
    expect(parsearCita("LISR — TRANSITORIOS")).toBeNull();
  });
});

describe("parsearVeredicto", () => {
  it("ok sin problemas", () => {
    expect(parsearVeredicto('{"ok": true, "problemas": [], "respuestaCorregida": null}')).toEqual({ ok: true, problemas: [], respuestaCorregida: null });
  });
  it("problemas con corrección, con texto alrededor", () => {
    const v = parsearVeredicto('Veredicto:\n{"ok": false, "problemas": [{"afirmacion": "monto de multa vigente 2026", "cita": "Art. 82 CFF", "motivo": "el texto no trae montos"}], "respuestaCorregida": "Respuesta corregida lo bastante larga para contar."}');
    expect(v?.ok).toBe(false);
    expect(v?.problemas).toHaveLength(1);
    expect(v?.respuestaCorregida).toMatch(/^Respuesta corregida/);
  });
  it("basura → null; problemas vacíos → ok aunque diga false", () => {
    expect(parsearVeredicto("nada")).toBeNull();
    expect(parsearVeredicto('{"ok": false, "problemas": []}')?.ok).toBe(true);
  });
});

describe("fuentesDesdeToolResult", () => {
  it("lee búsqueda y get_articulo; ignora basura", () => {
    expect(fuentesDesdeToolResult("search_fiscal_knowledge", JSON.stringify({ resultados: [{ cita: "Art. 27 LISR", texto: "x" }] }))).toEqual([{ cita: "Art. 27 LISR", texto: "x" }]);
    expect(fuentesDesdeToolResult("get_articulo", JSON.stringify({ cita: "Art. 29-A CFF", partes: [{ texto: "a" }, { texto: "b" }] }))).toEqual([{ cita: "Art. 29-A CFF", texto: "a\nb" }]);
    expect(fuentesDesdeToolResult("get_articulo", "no json")).toEqual([]);
  });
});

describe("fraccionesMencionadas", () => {
  it("lee «fracción V», listas y el sufijo 27-III; ignora lo que no es romano", () => {
    const f = fraccionesMencionadas("Art. 27, fracción V LISR; fracciones III, XVIII y XX del 28; el 93-XIV y 34-VI; fracción tercera");
    expect([...f].sort()).toEqual(["III", "V", "VI", "XIV", "XVIII", "XX"]);
  });
});

describe("seleccionarTexto", () => {
  const partes = [
    "Art. 27 LISR. Las deducciones deberán reunir:\nI. Ser estrictamente indispensables.",
    "Art. 27 LISR (continúa)\nII. Que tratándose de inversiones…",
    "Art. 27 LISR (continúa)\nV. Cumplir con las obligaciones en materia de retención… CFDI de nómina.",
    "Art. 27 LISR (continúa)\nXVIII. Que al realizar las operaciones… a más tardar el último día del ejercicio.",
  ];
  it("completa si cabe", () => {
    const r = seleccionarTexto(partes, new Set(["V"]), 10_000);
    expect(r.completo).toBe(true);
    expect(r.texto).toBe(partes.join("\n"));
  });
  it("recortada: preámbulo + las partes de las fracciones mencionadas, en orden, y marcada", () => {
    const max = partes[0].length + partes[2].length + partes[3].length + 3;
    const r = seleccionarTexto(partes, new Set(["V", "XVIII"]), max);
    expect(r.completo).toBe(false);
    expect(r.texto).toContain("V. Cumplir");
    expect(r.texto).toContain("XVIII. Que al realizar");
    expect(r.texto).not.toContain("II. Que tratándose");
    expect(r.texto.indexOf("V. Cumplir")).toBeLessThan(r.texto.indexOf("XVIII. Que al realizar"));
    expect(r.texto).toMatch(/texto recortado: faltan ~\d+ caracteres/);
  });
});

describe("motivoRechazoCorreccion", () => {
  const original = "Se deduce conforme al Art. 27 LISR y Art. 29-A CFF; el pago va con transferencia. ".repeat(3);
  it("acepta una corrección que sólo quita o marca", () => {
    expect(motivoRechazoCorreccion(original, original.replace("con transferencia", "(no pude verificarlo en el texto del Art. 27 LISR)"))).toBeNull();
  });
  it("rechaza citas nuevas y respuestas encogidas", () => {
    expect(motivoRechazoCorreccion(original, `${original} Además aplica el Art. 94 LISR.`)).toMatch(/citas nuevas: ART\. 94 LISR/);
    expect(motivoRechazoCorreccion(original, "Art. 27 LISR.")).toMatch(/encoge/);
  });
});
