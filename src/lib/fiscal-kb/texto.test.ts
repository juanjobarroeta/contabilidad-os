import { describe, expect, it } from "vitest";
import { extraerTexto, formatoDe } from "./texto";

const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(16).fill(0x20)]);

describe("formatoDe", () => {
  it("los bytes mágicos mandan: un «.doc» que es zip es docx, y viceversa", () => {
    expect(formatoDe("http://x/wo1.doc", null, bytes(0x50, 0x4b, 0x03, 0x04))).toBe("docx");
    expect(formatoDe("http://x/wo1.docx", null, bytes(0xd0, 0xcf, 0x11, 0xe0))).toBe("doc");
    expect(formatoDe("http://x/wo1.doc", null, bytes(0x25, 0x50, 0x44, 0x46))).toBe("pdf");
    expect(formatoDe("http://x/wo1.doc", null, bytes(0x7b, 0x5c, 0x72, 0x74, 0x66, 0x31))).toBe("rtf");
    expect(formatoDe("http://x/wo1.pdf", null, new TextEncoder().encode("  <!DOCTYPE html><html>…</html>       "))).toBe("html");
  });
  it("sin bytes reconocibles: extensión (ignorando query y mayúsculas), luego content-type, PDF por defecto", () => {
    expect(formatoDe("http://x/Documentos/Estatal/Puebla/wo1.DOC")).toBe("doc");
    expect(formatoDe("http://x/a.docx?v=2")).toBe("docx");
    expect(formatoDe("https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf")).toBe("pdf");
    expect(formatoDe("http://x/descarga.php?id=9", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("docx");
    expect(formatoDe("http://x/descarga.php?id=9", "application/msword")).toBe("doc");
    expect(formatoDe("http://x/descarga.php?id=9", null)).toBe("pdf");
  });
});

describe("extraerTexto", () => {
  it("html: quita etiquetas y decodifica lo básico", async () => {
    const t = await extraerTexto(new TextEncoder().encode("<html><body><p>Art&iacute;culo 1.</p><p>Texto</p></body></html>"), "html", "X");
    expect(t).toMatch(/Artículo 1\.\s*\n\s*Texto/);
  });
  it("un .doc sin antiword instalado falla con un mensaje que lo dice (no un ENOENT crudo)", async () => {
    // En CI y en la laptop no hay antiword; en la imagen del worker sí (ahí el
    // archivo de un byte haría fallar a antiword con el otro mensaje).
    await expect(extraerTexto(new Uint8Array([0]), "doc", "PRUEBA")).rejects.toThrow(/PRUEBA: (es un \.doc .*antiword|antiword falló)/);
  });
});
