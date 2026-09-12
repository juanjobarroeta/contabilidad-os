// ─────────────────────────────────────────────────────────────────────────────
// Redacción: el copiloto escribe un contrato, convenio o escrito y lo guarda
// como documento de la conversación (JuridicoDocumento con mime
// text/markdown), del que se descarga un .docx (docxDesdeMarkdown). El texto
// lo escribe el modelo entero en la llamada a la herramienta —no un
// esqueleto—; un borrador ya guardado se sustituye mandando su documento_id,
// así el abogado pide cambios y el chip sigue siendo el mismo.
//
// Lo puro (parsearMarkdown, docxDesdeMarkdown) se prueba en redaccion.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { Prisma } from "@prisma/client";
import { AlignmentType, Document, Footer, Packer, PageNumber, Paragraph, TextRun } from "docx";
import { prisma } from "@/lib/prisma";
import { indexarDocumento, limpiarTexto, type DocumentoCargado } from "./documentos";

export const MIME_BORRADOR = "text/markdown";
const MIN_CARACTERES = 300;

export const toolRedactar: Anthropic.Tool = {
  name: "redactar_documento",
  description:
    "Guarda un documento REDACTADO por ti (contrato, convenio, demanda, escrito, carta, dictamen) como documento de la conversación, listo para descargarse en Word. Úsala cuando el usuario pida redactar, preparar o modificar un documento. En `markdown` va el texto COMPLETO y final (no un resumen, no un esqueleto, no «[continúa]»), con la estructura usual en México: título; proemio con las partes; DECLARACIONES; CLÁUSULAS numeradas en ordinal («**PRIMERA.- OBJETO.**» al inicio del párrafo); cláusulas de vigencia, incumplimiento, jurisdicción y firmas. Los datos que no tengas van como [___] (nunca inventes nombres, montos, fechas ni números de artículo). Para cambiar un borrador ya guardado manda su `documento_id` con el texto completo actualizado. Después de guardar, responde al usuario en pocas líneas: qué decidiste y por qué, qué datos faltan ([___]) y qué cláusulas conviene que revise el abogado — no repitas el documento en el chat.",
  input_schema: {
    type: "object",
    properties: {
      titulo: { type: "string", description: "Título del documento, p. ej. «Contrato de mutuo con interés y garantía prendaria»." },
      tipo: { type: "string", description: "contrato | convenio | demanda | escrito | carta | dictamen | otro" },
      markdown: {
        type: "string",
        description: "Texto completo en Markdown: `#` para el título, `##` para apartados (DECLARACIONES, CLÁUSULAS, TRANSITORIOS), `**PRIMERA.- OBJETO.**` al inicio de cada cláusula, párrafos separados por una línea en blanco, listas con `-` o `1.`, líneas de firma con «_____». Sin tablas.",
      },
      documento_id: { type: "string", description: "Id de un borrador ya guardado en esta conversación para sustituir su contenido." },
      fundamentos: { type: "array", items: { type: "string" }, description: "Normas en que se apoyan las cláusulas clave, tal como las devolvieron las herramientas («Art. 2384 CCF»)." },
    },
    required: ["titulo", "markdown"],
  },
};

export interface DocumentoResumen {
  id: string;
  nombre: string;
  mime: string;
  bytes: number;
  paginas: number | null;
  caracteres: number;
  transcrito: boolean;
  createdAt: Date;
}

/** Guarda (o sustituye) el borrador. Devuelve la salida para el modelo y el documento para el chip del cliente. */
export async function ejecutarRedactar(
  input: Record<string, unknown>,
  ctx: { userId: string; conversacionId: string }
): Promise<{ salida: string; documento?: DocumentoResumen; cargado?: DocumentoCargado }> {
  const titulo = typeof input.titulo === "string" ? input.titulo.trim().slice(0, 180) : "";
  const markdown = typeof input.markdown === "string" ? limpiarTexto(input.markdown) : "";
  if (!titulo || markdown.length < MIN_CARACTERES) {
    return { salida: JSON.stringify({ error: `El documento necesita título y texto completo (llegaron ${markdown.length} caracteres). Escribe el documento entero en \`markdown\`.`, resumen: "borrador incompleto" }) };
  }
  const idPrevio = typeof input.documento_id === "string" && input.documento_id.trim() ? input.documento_id.trim() : null;
  const fundamentos = Array.isArray(input.fundamentos) ? input.fundamentos.map(String).slice(0, 40) : [];
  const secciones = indexarDocumento(markdown);
  const datos = {
    nombre: `${titulo}.docx`.slice(0, 200),
    mime: MIME_BORRADOR,
    bytes: Buffer.byteLength(markdown, "utf8"),
    hash: createHash("sha256").update(markdown).digest("hex"),
    paginas: null,
    caracteres: markdown.length,
    texto: markdown,
    secciones: secciones as unknown as Prisma.InputJsonValue,
  };
  const select = { id: true, nombre: true, mime: true, bytes: true, paginas: true, caracteres: true, createdAt: true } as const;
  let doc;
  let sustituido = false;
  if (idPrevio) {
    const previo = await prisma.juridicoDocumento.findFirst({ where: { id: idPrevio, conversacionId: ctx.conversacionId, userId: ctx.userId, mime: MIME_BORRADOR }, select: { id: true } });
    if (previo) {
      doc = await prisma.juridicoDocumento.update({ where: { id: previo.id }, data: datos, select });
      sustituido = true;
    }
  }
  if (!doc) doc = await prisma.juridicoDocumento.create({ data: { ...datos, conversacionId: ctx.conversacionId, userId: ctx.userId }, select });
  const faltantes = (markdown.match(/\[_{2,}\]/g) ?? []).length;
  return {
    salida: JSON.stringify({
      documento_id: doc.id,
      nombre: doc.nombre,
      caracteres: doc.caracteres,
      secciones: secciones.length,
      datos_faltantes: faltantes,
      fundamentos,
      descarga: `/api/juridico/documentos/${doc.id}/docx`,
      instruccion: `${sustituido ? "Borrador sustituido" : "Borrador guardado"}; el usuario ya lo ve como documento de la conversación con botón de descarga en Word. Ahora respóndele en pocas líneas (qué decidiste, qué falta, qué debe revisar el abogado) sin repetir el texto del documento.`,
      resumen: `${sustituido ? "sustituido" : "guardado"} «${titulo.slice(0, 50)}» · ${secciones.length} secciones${faltantes ? ` · ${faltantes} datos por llenar` : ""}`,
    }),
    documento: { ...doc, transcrito: false },
    cargado: { id: doc.id, nombre: doc.nombre, paginas: null, caracteres: markdown.length, texto: markdown, secciones },
  };
}

// ── Markdown → DOCX ──────────────────────────────────────────────────────────

export type Bloque =
  | { tipo: "titulo" | "apartado" | "subtitulo" | "parrafo" | "item" | "numerado" | "firma"; texto: string }
  | { tipo: "vacio" };

/** Bloques de un Markdown sencillo (lo que escribe el modelo): encabezados, párrafos, listas, firmas. */
export function parsearMarkdown(md: string): Bloque[] {
  const out: Bloque[] = [];
  let parrafo: string[] = [];
  const cerrar = () => {
    if (parrafo.length) out.push({ tipo: "parrafo", texto: parrafo.join(" ") });
    parrafo = [];
  };
  for (const cruda of md.replace(/\r\n?/g, "\n").split("\n")) {
    const l = cruda.trim();
    if (!l) {
      cerrar();
      if (out[out.length - 1]?.tipo !== "vacio") out.push({ tipo: "vacio" });
      continue;
    }
    if (/^---+$|^\*\*\*+$/.test(l)) {
      cerrar();
      continue;
    }
    const h = l.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      cerrar();
      out.push({ tipo: h[1].length === 1 ? "titulo" : h[1].length === 2 ? "apartado" : "subtitulo", texto: h[2].trim() });
      continue;
    }
    const item = l.match(/^[-*•]\s+(.*)$/);
    if (item) {
      cerrar();
      out.push({ tipo: "item", texto: item[1] });
      continue;
    }
    if (/^(\d{1,3}[.)]|[a-z][.)]|[ivxlc]{1,6}[.)])\s+/i.test(l)) {
      cerrar();
      out.push({ tipo: "numerado", texto: l });
      continue;
    }
    if (/^_{4,}/.test(l)) {
      cerrar();
      out.push({ tipo: "firma", texto: l });
      continue;
    }
    if (l.startsWith("|")) {
      cerrar();
      if (!/^\|[\s:-]+\|/.test(l)) out.push({ tipo: "parrafo", texto: l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).join("   ") });
      continue;
    }
    parrafo.push(l);
  }
  cerrar();
  while (out[out.length - 1]?.tipo === "vacio") out.pop();
  return out;
}

/** `**negrita**`, `*cursiva*`/`_cursiva_` → runs. */
export function runsDe(texto: string, base: { bold?: boolean; size?: number } = {}): TextRun[] {
  const runs: TextRun[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\n]+\*|_[^_\n]+_)/g;
  let pos = 0;
  for (const m of texto.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > pos) runs.push(new TextRun({ text: texto.slice(pos, i), ...base }));
    const t = m[0];
    if (t.startsWith("**")) runs.push(new TextRun({ text: t.slice(2, -2), ...base, bold: true }));
    else runs.push(new TextRun({ text: t.slice(1, -1), ...base, italics: true }));
    pos = i + t.length;
  }
  if (pos < texto.length) runs.push(new TextRun({ text: texto.slice(pos), ...base }));
  return runs;
}

/** Un .docx con tipografía de contrato: Times 12, justificado, apartados centrados, folio al pie. */
export async function docxDesdeMarkdown(md: string, titulo: string): Promise<Buffer> {
  const bloques = parsearMarkdown(md);
  const parrafos: Paragraph[] = [];
  let anterior: Bloque["tipo"] | null = null;
  for (const b of bloques) {
    switch (b.tipo) {
      case "vacio":
        break;
      case "titulo":
        parrafos.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 }, children: runsDe(b.texto.toUpperCase(), { bold: true, size: 26 }) }));
        break;
      case "apartado":
        parrafos.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 240, after: 160 }, children: runsDe(b.texto.toUpperCase(), { bold: true }) }));
        break;
      case "subtitulo":
        parrafos.push(new Paragraph({ alignment: AlignmentType.LEFT, spacing: { before: 160, after: 80 }, children: runsDe(b.texto, { bold: true }) }));
        break;
      case "parrafo":
        parrafos.push(new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { after: 160, line: 300 }, children: runsDe(b.texto) }));
        break;
      case "item":
        parrafos.push(new Paragraph({ alignment: AlignmentType.JUSTIFIED, bullet: { level: 0 }, spacing: { after: 80, line: 300 }, children: runsDe(b.texto) }));
        break;
      case "numerado":
        parrafos.push(new Paragraph({ alignment: AlignmentType.JUSTIFIED, indent: { left: 720, hanging: 360 }, spacing: { after: 80, line: 300 }, children: runsDe(b.texto) }));
        break;
      case "firma":
        parrafos.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: anterior === "firma" ? 0 : 480, after: 0 }, children: [new TextRun({ text: b.texto })] }));
        break;
    }
    anterior = b.tipo;
  }
  const doc = new Document({
    creator: "Copiloto jurídico",
    title: titulo,
    styles: { default: { document: { run: { font: "Times New Roman", size: 24 } } } },
    sections: [
      {
        properties: { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
        footers: {
          default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: ["Página ", PageNumber.CURRENT, " de ", PageNumber.TOTAL_PAGES], size: 18 })] })] }),
        },
        children: parrafos,
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}
