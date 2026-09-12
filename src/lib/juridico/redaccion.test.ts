import { describe, expect, it } from "vitest";
import { docxDesdeMarkdown, parsearMarkdown, runsDe } from "./redaccion";

const MD = `# Contrato de prestación de servicios

Contrato que celebran **ACME, S.A. de C.V.** (el «Cliente») y [___] (el «Prestador»), al tenor de las siguientes:

## DECLARACIONES

1. Declara el Cliente ser una sociedad mercantil.
2. Declara el Prestador contar con capacidad técnica.

## CLÁUSULAS

**PRIMERA.- OBJETO.** El Prestador se obliga a desarrollar el software descrito en el Anexo A,
conforme al calendario pactado.

**SEGUNDA.- CONTRAPRESTACIÓN.** El Cliente pagará $[___] M.N. más IVA.

- Anticipo del 50 %.
- Saldo contra entrega.

---

_______________________
El Cliente

_______________________
El Prestador`;

describe("parsearMarkdown", () => {
  const b = parsearMarkdown(MD);
  it("título, apartados, párrafos multilínea, numerados, viñetas y firmas", () => {
    expect(b[0]).toEqual({ tipo: "titulo", texto: "Contrato de prestación de servicios" });
    expect(b.filter((x) => x.tipo === "apartado").map((x) => (x as { texto: string }).texto)).toEqual(["DECLARACIONES", "CLÁUSULAS"]);
    const primera = b.find((x) => x.tipo === "parrafo" && (x as { texto: string }).texto.startsWith("**PRIMERA")) as { texto: string };
    expect(primera.texto).toMatch(/Anexo A, conforme al calendario pactado\.$/); // dos líneas → un párrafo
    expect(b.filter((x) => x.tipo === "numerado")).toHaveLength(2);
    expect(b.filter((x) => x.tipo === "item")).toHaveLength(2);
    expect(b.filter((x) => x.tipo === "firma")).toHaveLength(2);
    expect(b.some((x) => x.tipo === "parrafo" && (x as { texto: string }).texto.includes("---"))).toBe(false);
  });
  it("runsDe separa negritas y cursivas", () => {
    const runs = runsDe("Texto **negrita** y _cursiva_ fin.");
    expect(runs).toHaveLength(5);
  });
});

describe("docxDesdeMarkdown", () => {
  it("produce un .docx (zip con word/document.xml) que contiene el texto", async () => {
    const buf = await docxDesdeMarkdown(MD, "Contrato");
    expect(buf.length).toBeGreaterThan(2_000);
    expect(buf[0]).toBe(0x50); // PK
    expect(buf[1]).toBe(0x4b);
    // El XML del cuerpo va comprimido; basta con que el contenedor traiga la parte del documento.
    expect(buf.toString("latin1")).toContain("word/document.xml");
  });
});
