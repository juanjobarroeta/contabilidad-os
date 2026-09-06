import { describe, expect, it } from "vitest";
import { el, escaparAtributo, escaparTexto, limpiarTextoXml, serializarXml } from "./xml";

describe("serializarXml", () => {
  it("escapa texto y atributos", () => {
    expect(escaparTexto('a & b < c > "d"')).toBe('a &amp; b &lt; c &gt; "d"');
    expect(escaparAtributo(`x"y'z<`)).toBe("x&quot;y&apos;z&lt;");
    const xml = serializarXml(el("title", {}, ["Resumen <clínico> & alta"]));
    expect(xml).toBe("<title>Resumen &lt;clínico&gt; &amp; alta</title>");
  });

  it("autocierra vacíos, omite atributos nulos y sangra", () => {
    const doc = el("ClinicalDocument", { xmlns: "urn:hl7-org:v3", nada: null, oculto: false }, [
      el("realmCode", { code: "MX" }),
      el("recordTarget", {}, [el("patientRole", {}, [el("id", { root: "1.2.3", extension: "OERF920314MPLRZR06" })])]),
    ]);
    const xml = serializarXml(doc, { sangria: "  ", declaracion: true });
    expect(xml).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<ClinicalDocument xmlns="urn:hl7-org:v3">',
        '  <realmCode code="MX"/>',
        "  <recordTarget>",
        "    <patientRole>",
        '      <id root="1.2.3" extension="OERF920314MPLRZR06"/>',
        "    </patientRole>",
        "  </recordTarget>",
        "</ClinicalDocument>",
        "",
      ].join("\n")
    );
  });

  it("quita caracteres de control que XML 1.0 no admite y conserva saltos", () => {
    expect(limpiarTextoXml("a\u0001bc\nd\te")).toBe("abc\nd\te");
    const xml = serializarXml(el("text", {}, ["hola\u0007 mundo"]));
    expect(xml).toBe("<text>hola mundo</text>");
  });

  it("mezcla texto y elementos sin perder orden", () => {
    const xml = serializarXml(el("p", {}, ["Diagnóstico: ", el("b", {}, ["K80.2"]), " colelitiasis"]), { sangria: " " });
    expect(xml).toContain("<b>K80.2</b>");
    expect(xml.indexOf("Diagnóstico")).toBeLessThan(xml.indexOf("<b>"));
    expect(xml.indexOf("</b>")).toBeLessThan(xml.indexOf("colelitiasis"));
  });
});
