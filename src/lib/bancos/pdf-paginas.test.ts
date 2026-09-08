import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { rangosDeLotes, recortarPaginas } from "./pdf-paginas";

async function pdfDe(paginas: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < paginas; i++) doc.addPage([200, 200]).drawText(`p${i + 1}`);
  return Buffer.from(await doc.save());
}
const cuentaPaginas = async (b: Buffer) =>
  (await PDFDocument.load(new Uint8Array(b), { ignoreEncryption: true })).getPageCount();

describe("rangosDeLotes", () => {
  it("parte en lotes del tamaño pedido, con el último más corto", () => {
    expect(rangosDeLotes(11, 4)).toEqual([[1, 4], [5, 8], [9, 11]]);
    expect(rangosDeLotes(4, 4)).toEqual([[1, 4]]);
    expect(rangosDeLotes(0, 4)).toEqual([]);
  });
});

describe("recortarPaginas — el corte que se hacía con WASM y nunca arrancaba en producción", () => {
  it("devuelve un PDF válido con exactamente las páginas del rango", async () => {
    const buf = await pdfDe(11);
    const cut = await recortarPaginas(buf, 5, 8);
    expect(cut).not.toBeNull();
    expect(await cuentaPaginas(cut!)).toBe(4);
  });

  it("recorta el último lote aunque el rango se pase del total", async () => {
    const cut = await recortarPaginas(await pdfDe(11), 9, 12);
    expect(await cuentaPaginas(cut!)).toBe(3);
  });

  it("un rango imposible devuelve null en vez de lanzar", async () => {
    expect(await recortarPaginas(await pdfDe(3), 9, 12)).toBeNull();
  });

  it("con un archivo que no es PDF devuelve null, nunca revienta la subida", async () => {
    expect(await recortarPaginas(Buffer.from("no soy un pdf"), 1, 2)).toBeNull();
  });
});
