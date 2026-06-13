// Shared PDF→text extraction for the fiscal knowledge base. pdf-parse v2 ships
// a class API; @types/pdf-parse targets v1, so we require() and type the slice
// we use (same approach as the CSF parser in api/obligaciones/csf).
//
// The require lives INSIDE the function on purpose: pdf-parse pulls in pdfjs,
// which touches browser globals (DOMMatrix) at load time and crashes Next.js'
// build-time "collect page data" step if evaluated at module scope. Lazy-loading
// keeps it off the build path; it only runs when a PDF is actually parsed.

export async function parsePdfBuffer(buffer: Uint8Array, label = "documento"): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PDFParse } = require("pdf-parse") as {
    PDFParse: new (opts: { data: Uint8Array }) => { getText(): Promise<{ text: string }> };
  };
  const { text } = await new PDFParse({ data: buffer }).getText();
  if (!text || text.length < 2_000) {
    throw new Error(`PDF de ${label} produjo texto sospechosamente corto (${text?.length ?? 0} chars) — ¿es escaneado/imagen?`);
  }
  return text;
}
