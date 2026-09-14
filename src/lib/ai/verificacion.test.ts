import { describe, expect, it } from "vitest";
import { construirCitas, clasificarCitas, fraccionesMencionadas, fuentesDesdeToolResult, motivoRechazoCorreccion, parsearCita, parsearVeredicto, seleccionarTexto, resolverCitaEstatal } from "./verificacion";

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
    const v = fuentesDesdeToolResult("get_valor_fiscal", JSON.stringify({ tipo: "multa", cita: "Art. 82 CFF", filas: [{ minimo: 2050, maximo: 25360 }] }));
    expect(v).toHaveLength(1);
    expect(v[0].cita).toBe("Valores oficiales · multa");
    expect(v[0].texto).toContain("25360");
    expect(fuentesDesdeToolResult("get_valor_fiscal", JSON.stringify({ tipo: "multa", error: "no hay" }))).toEqual([]);
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

describe("resolverCitaEstatal", () => {
  const fuentes = [
    { cita: "Art. 486 CHH-C-PROCEDIMIENTOS-FAMILIARES-CH", texto: "ARTÍCULO 486. La apelación solo procede en efecto devolutivo…" },
    { cita: "Art. 485 CHH-C-PROCEDIMIENTOS-FAMILIARES-CH", texto: "ARTÍCULO 485. La apelación debe interponerse dentro de los seis días…" },
    { cita: "Art. 63 COA-C-PROCEDIMIENTOS-FAMILIARES-CO", texto: "ARTÍCULO 63. …" },
  ];
  it("«Art. 486 CPF Chihuahua» se resuelve contra la fuente CHH-… del mismo artículo, no contra el Código Penal Federal", () => {
    const respuesta = "- **Art. 486 CPF Chihuahua**: la apelación procede en efecto devolutivo.\n- **Art. 485 del CPF del Estado de Chihuahua**: seis días.";
    expect(resolverCitaEstatal("ART. 486 CPF", respuesta, fuentes)?.cita).toBe("Art. 486 CHH-C-PROCEDIMIENTOS-FAMILIARES-CH");
    expect(resolverCitaEstatal("ART. 485 CPF", respuesta, fuentes)?.cita).toBe("Art. 485 CHH-C-PROCEDIMIENTOS-FAMILIARES-CH");
  });
  it("sin estado junto a la cita, o con un estado del que no hay fuente, no resuelve", () => {
    expect(resolverCitaEstatal("ART. 486 CPF", "Conforme al Art. 486 CPF, procede.", fuentes)).toBeNull();
    expect(resolverCitaEstatal("ART. 486 CPF", "Art. 486 CPF Puebla", fuentes)).toBeNull();
    expect(resolverCitaEstatal("ART. 63 CPF", "Art. 63 CPF Coahuila", fuentes)?.cita).toBe("Art. 63 COA-C-PROCEDIMIENTOS-FAMILIARES-CO");
  });
});

describe("construirCitas", () => {
  const fuentes = [
    { cita: "Art. 486 CHH-C-PROCEDIMIENTOS-FAMILIARES-CH" },
    { cita: "Art. 27 LISR" },
    { cita: "Valores oficiales · UMA" },
  ];
  const texto = "Procede la apelación conforme al artículo 486 del CPF Chihuahua, y el gasto es deducible por el artículo 27 LISR. La regla 2.7.1.32 RMF y la tesis reg. 2021760 apoyan lo anterior. Ver también el artículo 999 LIVA.";

  it("marca cada cita con su lugar, su norma y su veredicto", () => {
    const citas = construirCitas({
      texto,
      fuentes,
      resueltas: [
        { cita: "ART. 486 CPF", fundamento: { cita: "Art. 486 CHH-C-PROCEDIMIENTOS-FAMILIARES-CH", ley: "CHH-C-PROCEDIMIENTOS-FAMILIARES-CH", articulo: "486", titulo: "Código de Procedimientos Familiares del Estado de Chihuahua", url: "https://x" } },
        { cita: "ART. 27 LISR", fundamento: { cita: "Art. 27 LISR" } },
        { cita: "ART. 999 LIVA", fundamento: null },
      ],
      problemas: [{ afirmacion: "el gasto es deducible", cita: "Art. 27 LISR", motivo: "el artículo no dice eso" }],
      citasNoVerificables: ["ART. 999 LIVA"],
      verificada: true,
      corregida: true,
    });
    expect(citas.map((c) => [c.id, c.cita, c.estado])).toEqual([
      ["c1", "ART. 486 CPF", "verificada"],
      ["c2", "ART. 27 LISR", "corregida"],
      ["c3", "REGLA 2.7.1.32 RMF", "fuera_de_base"],
      ["c4", "REG. 2021760", "fuera_de_base"],
      ["c5", "ART. 999 LIVA", "fuera_de_base"],
    ]);
    // Los offsets apuntan al texto literal que el abogado lee.
    for (const c of citas) expect(texto.slice(c.inicio, c.fin)).toBe(c.textoEnRespuesta);
    expect(citas[0].fundamento?.titulo).toContain("Chihuahua");
    expect(citas[1].motivo).toBe("el artículo no dice eso");
  });

  it("una corrección descartada deja la cita «observada», y sin verificación todas quedan «sin_verificar» pero con su norma", () => {
    const observada = construirCitas({ texto, fuentes, resueltas: [{ cita: "ART. 27 LISR", fundamento: { cita: "Art. 27 LISR" } }], problemas: [{ afirmacion: "x", cita: "Art. 27 LISR", motivo: "no lo sostiene" }], citasNoVerificables: [], verificada: true, corregida: false });
    expect(observada.find((c) => c.cita === "ART. 27 LISR")?.estado).toBe("observada");
    const sin = construirCitas({ texto, fuentes, verificada: false, corregida: false });
    expect(new Set(sin.map((c) => c.estado))).toEqual(new Set(["sin_verificar"]));
    expect(sin.find((c) => c.cita === "ART. 486 CPF")?.fundamento?.cita).toBe("Art. 486 CHH-C-PROCEDIMIENTOS-FAMILIARES-CH");
    // Las tablas de valores no son fundamento de una cita.
    expect(sin.some((c) => c.fundamento?.cita.startsWith("Valores oficiales"))).toBe(false);
  });
});
