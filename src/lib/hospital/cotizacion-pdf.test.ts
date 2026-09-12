import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { PDFParse } from "pdf-parse";
import { dinero, envolver, fechaLarga, generarPdfCotizacion, textoSeguro, type CotizacionParaPdf, type EmisorParaPdf } from "./cotizacion-pdf";

const emisor: EmisorParaPdf = {
  nombre: "Hospital Haltus Hope", razonSocial: "Haltus Hope SA de CV", rfc: "HHO200101AB1",
  domicilio: "Av. Reforma 100, Col. Centro, 06000 Ciudad de México", telefono: "55 1234 5678", email: "hola@haltus.test",
  clues: "DFSSA001234", licenciaSanitaria: "LS-2024-0099",
};
const cot: CotizacionParaPdf = {
  folio: "COT-0007", estado: "ENVIADA", createdAt: new Date("2026-09-12T15:00:00Z"), vigenciaHasta: new Date("2026-09-27T05:59:00Z"),
  pacienteNombre: "María José Pérez Núñez", procedimiento: "Colecistectomía laparoscópica", notas: "Incluye una noche de habitación; excepciones autorizadas por Dra. Ruiz.",
  pagador: { nombre: "Axa Seguros", tabulador: "AXA 2026" },
  partidas: [
    { descripcion: "Habitación estándar", categoria: "HABITACION", cantidad: 1, precioUnitario: 3500, ivaTasa: 0.16, importe: 3500 },
    { descripcion: "Honorarios cirujano", categoria: "HONORARIO", cantidad: 1, precioUnitario: 25000, ivaTasa: null, importe: 25000 },
    { descripcion: "Ketorolaco 30 mg ampolleta", categoria: "FARMACIA", cantidad: 2.5, precioUnitario: 120.5, ivaTasa: 0, importe: 301.25 },
  ],
  subtotal: 28801.25, iva: 560, total: 29361.25,
};

async function texto(bytes: Uint8Array): Promise<string> {
  const parser = new PDFParse({ data: bytes });
  try { return (await parser.getText()).text; } finally { await parser.destroy(); }
}

describe("textoSeguro — lo que Helvetica puede dibujar", () => {
  it("conserva acentos, eñes y los signos tipográficos de WinAnsi; lo demás se vuelve espacio", () => {
    expect(textoSeguro("Colecistectomía «laparoscópica» — 16 % · ¿ok?")).toBe("Colecistectomía «laparoscópica» — 16 % · ¿ok?");
    expect(textoSeguro("dosis ≥ 5 mg 💊")).toBe("dosis 5 mg");
    expect(textoSeguro("dos\nrenglones\tcon\ttabs")).toBe("dos renglones con tabs");
    expect(textoSeguro(null)).toBe("");
  });
});

describe("dinero y fechas, en español de México", () => {
  it("pesos con dos decimales y fecha larga en hora de México", () => {
    expect(dinero(29361.25)).toBe("$29,361.25");
    expect(dinero(Number.NaN)).toBe("$0.00");
    expect(fechaLarga("2026-09-27T05:59:00Z")).toBe("26 de septiembre de 2026");
    expect(fechaLarga(null)).toBe("—");
  });
});

describe("envolver — renglones que caben en la columna", () => {
  it("parte por palabras y corta a la fuerza una palabra más ancha que la columna", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const lineas = envolver("Resonancia magnética de columna lumbar con contraste", font, 9.5, 120);
    expect(lineas.length).toBeGreaterThan(1);
    for (const l of lineas) expect(font.widthOfTextAtSize(l, 9.5)).toBeLessThanOrEqual(120);
    const larga = envolver("x".repeat(80), font, 9.5, 60);
    expect(larga.length).toBeGreaterThan(1);
    expect(larga.join("")).toBe("x".repeat(80));
    expect(envolver("", font, 9.5, 100)).toEqual([""]);
  });
});

describe("generarPdfCotizacion", () => {
  it("una carta con emisor, folio, paciente, pagador, cada partida y el total estimado", async () => {
    const bytes = await generarPdfCotizacion(cot, emisor, new Date("2026-09-12T15:00:00Z"));
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    expect(doc.getTitle()).toBe("Cotización COT-0007");

    const t = await texto(bytes);
    for (const esperado of ["Hospital Haltus Hope", "HHO200101AB1", "CLUES DFSSA001234", "COT-0007", "María José Pérez Núñez", "Axa Seguros", "tarifario AXA 2026",
      "Colecistectomía laparoscópica", "Habitación estándar", "Honorarios cirujano", "Ketorolaco 30 mg ampolleta", "Exento", "16 %", "$25,000.00", "$29,361.25",
      "Total estimado", "vigente hasta el 26 de septiembre de 2026", "Dra. Ruiz", "Página 1 de 1"]) {
      expect(t, esperado).toContain(esperado);
    }
  });

  it("muchas partidas: varias páginas, el encabezado de la tabla se repite y el pie numera todas", async () => {
    const partidas = Array.from({ length: 60 }, (_, i) => ({ descripcion: `Partida ${i + 1} de una lista larga para forzar el salto de página`, categoria: "ESTUDIO", cantidad: 1, precioUnitario: 100, ivaTasa: 0.16, importe: 100 }));
    const bytes = await generarPdfCotizacion({ ...cot, partidas, subtotal: 6000, iva: 960, total: 6960 }, emisor);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
    const t = await texto(bytes);
    expect(t).toContain(`Página ${doc.getPageCount()} de ${doc.getPageCount()}`);
    expect(t.match(/Concepto/g)?.length).toBe(doc.getPageCount());
    expect(t).toContain("Partida 60 de una lista");
  });

  it("sin partidas, sin pagador, sin vigencia ni notas: se dice, no se rompe", async () => {
    const bytes = await generarPdfCotizacion({ ...cot, partidas: [], pagador: null, vigenciaHasta: null, notas: null, subtotal: 0, iva: 0, total: 0 }, { ...emisor, domicilio: null, telefono: null, email: null, clues: null, licenciaSanitaria: null });
    const t = await texto(bytes);
    expect(t).toContain("Sin partidas.");
    expect(t).toContain("Particular · precio de lista");
    expect(t).toContain("Vigente hasta: —");
    expect(t).not.toContain("Notas");
  });
});
