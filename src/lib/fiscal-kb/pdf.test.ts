import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { parsePdfBuffer } from "./pdf";

async function pdfConTexto(lineas: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let page = doc.addPage([612, 792]);
  for (let i = 0; i < lineas; i++) {
    if (i % 60 === 0 && i > 0) page = doc.addPage([612, 792]);
    page.drawText(`ARTICULO ${i + 1}. Texto de prueba suficientemente largo para el parser de la base.`, { x: 40, y: 760 - (i % 60) * 12, size: 9, font });
  }
  return doc.save();
}

describe("parsePdfBuffer", () => {
  it("no deja detached el buffer del llamador (pdf.js transfiere el ArrayBuffer a su worker)", async () => {
    const buffer = await pdfConTexto(80);
    const antes = buffer.byteLength;
    const texto = await parsePdfBuffer(buffer, "prueba");
    expect(texto).toContain("ARTICULO 1.");
    expect(buffer.byteLength).toBe(antes);
    expect((buffer.buffer as ArrayBuffer & { detached?: boolean }).detached).not.toBe(true);
  });
});
