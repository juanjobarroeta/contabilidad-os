// Shared PDF→text extraction for the fiscal knowledge base. pdf-parse v2 ships
// a class API; @types/pdf-parse targets v1, so we require() and type the slice
// we use (same approach as the CSF parser in api/obligaciones/csf).

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PDFParse } = require("pdf-parse") as {
  PDFParse: new (opts: { data: Uint8Array }) => { getText(): Promise<{ text: string }> };
};

export async function parsePdfBuffer(buffer: Uint8Array, label = "documento"): Promise<string> {
  const { text } = await new PDFParse({ data: buffer }).getText();
  if (!text || text.length < 2_000) {
    throw new Error(`PDF de ${label} produjo texto sospechosamente corto (${text?.length ?? 0} chars) — ¿es escaneado/imagen?`);
  }
  return text;
}
