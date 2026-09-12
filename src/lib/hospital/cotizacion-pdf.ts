// ─────────────────────────────────────────────────────────────────────────────
// LA COTIZACIÓN EN PAPEL.
//
// Una cotización se hace para entregarse: al paciente que la pide antes de
// decidirse, a la aseguradora que la exige para autorizar, al familiar que
// paga. Hasta ahora sólo vivía en pantalla. Este módulo la vuelve un PDF
// carta con lo que un tercero necesita leer: quién la emite, para quién, qué
// procedimiento, cada partida con su precio y su IVA, y el total estimado
// con su vigencia.
//
// Puro: recibe la cotización ya serializada (números, no Decimals) y los datos
// del emisor, y devuelve los bytes. La ruta sólo carga y sirve. Se usa
// pdf-lib con Helvetica (WinAnsi): lo que no cabe en esa codificación —un
// «≥», un emoji— se deja fuera del texto en vez de tirar el PDF entero.
// ─────────────────────────────────────────────────────────────────────────────

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";

export type PartidaParaPdf = {
  descripcion: string;
  categoria: string;
  cantidad: number;
  precioUnitario: number;
  ivaTasa: number | null;
  importe: number;
};

export type CotizacionParaPdf = {
  folio: string;
  estado: string;
  createdAt: Date | string;
  vigenciaHasta: Date | string | null;
  pacienteNombre: string;
  procedimiento: string;
  notas: string | null;
  pagador: { nombre: string; tabulador: string | null } | null;
  partidas: PartidaParaPdf[];
  subtotal: number;
  iva: number;
  total: number;
};

export type EmisorParaPdf = {
  /** Como lo enseña el satélite: nombre del hospital, o el comercial, o la razón social. */
  nombre: string;
  razonSocial: string;
  rfc: string;
  domicilio: string | null;
  telefono: string | null;
  email: string | null;
  clues: string | null;
  licenciaSanitaria: string | null;
};

const CATEGORIA: Record<string, string> = {
  HABITACION: "Habitación", QUIROFANO: "Quirófano", URGENCIAS: "Urgencias", ESTUDIO: "Estudios",
  PROCEDIMIENTO: "Procedimientos", HONORARIO: "Honorarios médicos", FARMACIA: "Farmacia",
  MATERIAL: "Material", EQUIPO: "Equipo", OTRO: "Otros",
};
const ESTADO: Record<string, string> = {
  BORRADOR: "Borrador", ENVIADA: "Enviada", ACEPTADA: "Aceptada", VENCIDA: "Vencida",
  CONVERTIDA: "Convertida en ingreso", CANCELADA: "Cancelada",
};

// Fuera de Latin-1, WinAnsi sólo tiene estos.
const WINANSI_EXTRA = new Set([0x20ac, 0x0152, 0x0153, 0x0160, 0x0161, 0x0178, 0x017d, 0x017e, 0x0192, 0x02c6, 0x02dc, 0x2013, 0x2014, 0x2018, 0x2019, 0x201a, 0x201c, 0x201d, 0x201e, 0x2020, 0x2021, 0x2022, 0x2026, 0x2030, 0x2039, 0x203a, 0x2122]);

/** Deja sólo lo que Helvetica (WinAnsi) puede dibujar; lo demás se vuelve un espacio. */
export function textoSeguro(s: string | null | undefined): string {
  if (!s) return "";
  let out = "";
  for (const ch of s.normalize("NFC")) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0x0a || c === 0x09) out += " ";
    else if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WINANSI_EXTRA.has(c)) out += ch;
    else if (c < 0x20 || (c >= 0x7f && c < 0xa0)) continue;
    else out += " ";
  }
  return out.replace(/ {2,}/g, " ").trim();
}

const mxn = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", minimumFractionDigits: 2 });
export const dinero = (n: number): string => mxn.format(Number.isFinite(n) ? n : 0);
const cantidad = (n: number): string => (Number.isInteger(n) ? String(n) : n.toLocaleString("es-MX", { maximumFractionDigits: 3 }));
export const fechaLarga = (d: Date | string | null | undefined): string => {
  if (!d) return "—";
  const f = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(f.getTime())) return "—";
  return f.toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric", timeZone: "America/Mexico_City" });
};
const ivaTexto = (t: number | null): string => (t == null ? "Exento" : `${Math.round(t * 100)} %`);

/** Parte un texto en renglones que quepan en `ancho` con esa fuente y tamaño. */
export function envolver(texto: string, font: PDFFont, size: number, ancho: number): string[] {
  const palabras = textoSeguro(texto).split(" ").filter(Boolean);
  const lineas: string[] = [];
  let actual = "";
  for (const p of palabras) {
    const prueba = actual ? `${actual} ${p}` : p;
    if (font.widthOfTextAtSize(prueba, size) <= ancho) { actual = prueba; continue; }
    if (actual) lineas.push(actual);
    // Una sola palabra más ancha que la columna se corta a la fuerza.
    let resto = p;
    while (font.widthOfTextAtSize(resto, size) > ancho && resto.length > 1) {
      let corte = resto.length - 1;
      while (corte > 1 && font.widthOfTextAtSize(resto.slice(0, corte), size) > ancho) corte--;
      lineas.push(resto.slice(0, corte));
      resto = resto.slice(corte);
    }
    actual = resto;
  }
  if (actual) lineas.push(actual);
  return lineas.length ? lineas : [""];
}

const CARTA: [number, number] = [612, 792];
const MARGEN = 48;
const ANCHO = CARTA[0] - MARGEN * 2;
const TINTA = rgb(0.1, 0.1, 0.12);
const GRIS = rgb(0.45, 0.45, 0.5);
const LINEA = rgb(0.82, 0.82, 0.85);
const SUAVE = rgb(0.955, 0.955, 0.965);

// Columnas de la tabla (x absolutas; las numéricas se alinean a la derecha).
// El importe necesita sitio para «$1,234,567.89» sin pisar el IVA de al lado.
const COL = { concepto: MARGEN, cant: 350, unitario: 434, iva: 450, importe: CARTA[0] - MARGEN };
const ANCHO_CONCEPTO = COL.cant - 30 - MARGEN;
// Totales: etiqueta alineada a la derecha, lejos del importe.
const X_ETIQUETA_TOTAL = COL.importe - 116;

type Lienzo = { pdf: PDFDocument; page: PDFPage; y: number; regular: PDFFont; negrita: PDFFont; paginas: PDFPage[] };

function textoDerecha(page: PDFPage, texto: string, xDerecha: number, y: number, font: PDFFont, size: number, color = TINTA) {
  page.drawText(texto, { x: xDerecha - font.widthOfTextAtSize(texto, size), y, size, font, color });
}

function nuevaPagina(l: Lienzo) {
  l.page = l.pdf.addPage(CARTA);
  l.paginas.push(l.page);
  l.y = CARTA[1] - MARGEN;
}

function encabezadoTabla(l: Lienzo) {
  const { page, regular } = l;
  page.drawRectangle({ x: MARGEN, y: l.y - 16, width: ANCHO, height: 18, color: SUAVE });
  const y = l.y - 11;
  page.drawText("Concepto", { x: COL.concepto + 6, y, size: 8.5, font: regular, color: GRIS });
  textoDerecha(page, "Cant.", COL.cant, y, regular, 8.5, GRIS);
  textoDerecha(page, "P. unitario", COL.unitario, y, regular, 8.5, GRIS);
  page.drawText("IVA", { x: COL.iva, y, size: 8.5, font: regular, color: GRIS });
  textoDerecha(page, "Importe", COL.importe - 6, y, regular, 8.5, GRIS);
  l.y -= 24;
}

export async function generarPdfCotizacion(c: CotizacionParaPdf, emisor: EmisorParaPdf, hoy: Date = new Date()): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Cotización ${c.folio}`);
  pdf.setAuthor(textoSeguro(emisor.nombre));
  pdf.setCreationDate(hoy);
  pdf.setModificationDate(hoy);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const negrita = await pdf.embedFont(StandardFonts.HelveticaBold);
  const l: Lienzo = { pdf, page: undefined as unknown as PDFPage, y: 0, regular, negrita, paginas: [] };
  nuevaPagina(l);

  // ── Emisor (izquierda) y folio (derecha) ──────────────────────────────────
  const { page } = l;
  page.drawText(textoSeguro(emisor.nombre), { x: MARGEN, y: l.y - 14, size: 15, font: negrita, color: TINTA });
  const lineasEmisor = [
    emisor.razonSocial && emisor.razonSocial !== emisor.nombre ? `${emisor.razonSocial} · RFC ${emisor.rfc}` : `RFC ${emisor.rfc}`,
    emisor.domicilio,
    [emisor.telefono, emisor.email].filter(Boolean).join(" · "),
    [emisor.clues ? `CLUES ${emisor.clues}` : null, emisor.licenciaSanitaria ? `Licencia sanitaria ${emisor.licenciaSanitaria}` : null].filter(Boolean).join(" · "),
  ].map((t) => textoSeguro(t)).filter(Boolean);
  let y = l.y - 30;
  for (const t of lineasEmisor) { page.drawText(t, { x: MARGEN, y, size: 8.5, font: regular, color: GRIS }); y -= 11.5; }

  textoDerecha(page, "COTIZACIÓN", COL.importe, l.y - 14, regular, 9, GRIS);
  textoDerecha(page, textoSeguro(c.folio), COL.importe, l.y - 32, negrita, 15);
  textoDerecha(page, `Fecha: ${fechaLarga(c.createdAt)}`, COL.importe, l.y - 48, regular, 8.5, GRIS);
  textoDerecha(page, `Vigente hasta: ${fechaLarga(c.vigenciaHasta)}`, COL.importe, l.y - 59.5, regular, 8.5, GRIS);
  textoDerecha(page, ESTADO[c.estado] ?? textoSeguro(c.estado), COL.importe, l.y - 71, regular, 8.5, GRIS);

  l.y = Math.min(y, l.y - 80) - 10;
  page.drawLine({ start: { x: MARGEN, y: l.y }, end: { x: CARTA[0] - MARGEN, y: l.y }, thickness: 0.6, color: LINEA });
  l.y -= 18;

  // ── Para quién y qué ──────────────────────────────────────────────────────
  const datos: Array<[string, string]> = [
    ["Paciente", c.pacienteNombre],
    ["Pagador", c.pagador ? `${c.pagador.nombre}${c.pagador.tabulador ? ` · tarifario ${c.pagador.tabulador}` : ""}` : "Particular · precio de lista"],
    ["Procedimiento", c.procedimiento],
  ];
  for (const [k, v] of datos) {
    page.drawText(k, { x: MARGEN, y: l.y, size: 8.5, font: regular, color: GRIS });
    const lineas = envolver(v, negrita, 10.5, ANCHO - 90);
    for (const t of lineas) { page.drawText(t, { x: MARGEN + 90, y: l.y, size: 10.5, font: negrita, color: TINTA }); l.y -= 14; }
    l.y -= 2;
  }
  l.y -= 8;

  // ── Partidas ──────────────────────────────────────────────────────────────
  encabezadoTabla(l);
  for (const p of c.partidas) {
    const lineas = envolver(p.descripcion, regular, 9.5, ANCHO_CONCEPTO);
    const alto = lineas.length * 11.5 + 12 + 6;
    if (l.y - alto < MARGEN + 90) { nuevaPagina(l); encabezadoTabla(l); }
    const pg = l.page;
    let yy = l.y;
    for (const t of lineas) { pg.drawText(t, { x: COL.concepto + 6, y: yy, size: 9.5, font: regular, color: TINTA }); yy -= 11.5; }
    pg.drawText(CATEGORIA[p.categoria] ?? textoSeguro(p.categoria), { x: COL.concepto + 6, y: yy, size: 7.5, font: regular, color: GRIS });
    textoDerecha(pg, cantidad(p.cantidad), COL.cant, l.y, regular, 9.5);
    textoDerecha(pg, dinero(p.precioUnitario), COL.unitario, l.y, regular, 9.5);
    pg.drawText(ivaTexto(p.ivaTasa), { x: COL.iva, y: l.y, size: 9.5, font: regular, color: TINTA });
    textoDerecha(pg, dinero(p.importe), COL.importe - 6, l.y, regular, 9.5);
    l.y = yy - 10;
    pg.drawLine({ start: { x: MARGEN, y: l.y + 4 }, end: { x: CARTA[0] - MARGEN, y: l.y + 4 }, thickness: 0.4, color: LINEA });
    l.y -= 6;
  }
  if (c.partidas.length === 0) {
    l.page.drawText("Sin partidas.", { x: COL.concepto + 6, y: l.y, size: 9.5, font: regular, color: GRIS });
    l.y -= 18;
  }

  // ── Totales ───────────────────────────────────────────────────────────────
  if (l.y < MARGEN + 110) nuevaPagina(l);
  l.y -= 4;
  const totales: Array<[string, string, PDFFont, number]> = [
    ["Subtotal", dinero(c.subtotal), regular, 9.5],
    ["IVA", dinero(c.iva), regular, 9.5],
    ["Total estimado", dinero(c.total), negrita, 12],
  ];
  for (const [k, v, font, size] of totales) {
    textoDerecha(l.page, k, X_ETIQUETA_TOTAL, l.y, font === negrita ? negrita : regular, size === 12 ? 10 : 9, font === negrita ? TINTA : GRIS);
    textoDerecha(l.page, v, COL.importe - 6, l.y, font, size);
    l.y -= size + 6;
  }

  // ── Notas ─────────────────────────────────────────────────────────────────
  if (c.notas && textoSeguro(c.notas)) {
    l.y -= 10;
    const lineas = envolver(c.notas, regular, 9, ANCHO);
    if (l.y - lineas.length * 11.5 < MARGEN + 60) nuevaPagina(l);
    l.page.drawText("Notas", { x: MARGEN, y: l.y, size: 8.5, font: regular, color: GRIS });
    l.y -= 13;
    for (const t of lineas) { l.page.drawText(t, { x: MARGEN, y: l.y, size: 9, font: regular, color: TINTA }); l.y -= 11.5; }
  }

  // ── Pie en cada página ────────────────────────────────────────────────────
  const aviso = `Importe estimado con los precios vigentes al ${fechaLarga(c.createdAt)}; el importe final depende de la atención que se brinde. ${c.vigenciaHasta ? `Cotización vigente hasta el ${fechaLarga(c.vigenciaHasta)}.` : ""}`.trim();
  const n = l.paginas.length;
  l.paginas.forEach((pg, i) => {
    pg.drawLine({ start: { x: MARGEN, y: MARGEN + 22 }, end: { x: CARTA[0] - MARGEN, y: MARGEN + 22 }, thickness: 0.4, color: LINEA });
    const lineas = envolver(aviso, regular, 7.5, ANCHO - 70);
    let yy = MARGEN + 10;
    for (const t of lineas) { pg.drawText(t, { x: MARGEN, y: yy, size: 7.5, font: regular, color: GRIS }); yy -= 9.5; }
    textoDerecha(pg, `Página ${i + 1} de ${n}`, COL.importe, MARGEN + 10, regular, 7.5, GRIS);
  });

  return pdf.save();
}
