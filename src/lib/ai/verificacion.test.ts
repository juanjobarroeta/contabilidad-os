import { describe, expect, it } from "vitest";
import { clasificarCitas, fuentesDesdeToolResult, parsearCita, parsearVeredicto } from "./verificacion";

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
