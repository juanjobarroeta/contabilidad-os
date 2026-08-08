import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { descargarXmlDeRef, type DescargadorDeArchivos } from "./descarga-xml";

// Los CE del SAT llegan como .zip (AMA170817NK1202312CT.zip). Pasarlos directo
// al parser de XML devolvía 0 cuentas SIN error — el bug silencioso del
// ceBootstrap. Estos tests fijan el contrato: zip → se extrae el .xml; texto
// plano → pasa tal cual; zip sin xml → error explícito (no silencio).

const XML = `<?xml version="1.0"?><catalogocuentas:Catalogo><catalogocuentas:Ctas CodAgrup="101" NumCta="101.01" Desc="Caja" Nivel="1" Natur="D"/></catalogocuentas:Catalogo>`;

function stub(bytes: Uint8Array): DescargadorDeArchivos {
  const copia = bytes.slice(); // ArrayBuffer propio, sin offset
  return { downloadAcuse: async () => ({ data: copia.buffer as ArrayBuffer }) };
}

describe("descargarXmlDeRef", () => {
  it("extrae el .xml de un zip (como los entrega el SAT)", async () => {
    const zip = new JSZip();
    zip.file("AMA170817NK1202312CT.xml", XML);
    const bytes = await zip.generateAsync({ type: "uint8array" });

    const xml = await descargarXmlDeRef(stub(bytes), "/files/abc");
    expect(xml).toBe(XML);
  });

  it("ignora entradas no-xml y carpetas dentro del zip", async () => {
    const zip = new JSZip();
    zip.folder("adjuntos");
    zip.file("leeme.txt", "no soy el xml");
    zip.file("catalogo.XML", XML); // extensión en mayúsculas también cuenta
    const bytes = await zip.generateAsync({ type: "uint8array" });

    expect(await descargarXmlDeRef(stub(bytes), "/files/abc")).toBe(XML);
  });

  it("texto plano (XML sin comprimir) pasa tal cual", async () => {
    const bytes = new TextEncoder().encode(XML);
    expect(await descargarXmlDeRef(stub(bytes), "/files/abc")).toBe(XML);
  });

  it("zip sin ningún .xml truena con error explícito (no silencio)", async () => {
    const zip = new JSZip();
    zip.file("acuse.pdf", "%PDF-fake");
    const bytes = await zip.generateAsync({ type: "uint8array" });

    await expect(descargarXmlDeRef(stub(bytes), "/files/abc")).rejects.toThrow(/no contiene ningún .xml/);
  });
});
