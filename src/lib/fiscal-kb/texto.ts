// ─────────────────────────────────────────────────────────────────────────────
// Texto de un ordenamiento según su formato REAL. Diputados y el SAT publican
// PDF; el Orden Jurídico Nacional (estados y municipios) publica la mitad en
// Word, y la extensión miente: muchos «.doc» son Word 2007+ (zip) y algún
// «.pdf» es otra cosa. Por eso se detecta por los bytes mágicos y la extensión
// sólo desempata. .docx → mammoth (puro JS); .doc de Word 97 → antiword y
// RTF → unrtf, ambos instalados en la imagen del worker (Dockerfile.ce-worker).
// El app web sólo ingiere PDF y .docx.
// ─────────────────────────────────────────────────────────────────────────────

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parsePdfBuffer } from "./pdf";

const execFileAsync = promisify(execFile);

export type Formato = "pdf" | "docx" | "doc" | "rtf" | "html";

function porExtension(url: string, contentType?: string | null): Formato {
  const limpia = url.split(/[?#]/)[0].toLowerCase();
  if (limpia.endsWith(".docx")) return "docx";
  if (limpia.endsWith(".doc")) return "doc";
  if (limpia.endsWith(".rtf")) return "rtf";
  if (limpia.endsWith(".pdf")) return "pdf";
  if (contentType?.includes("wordprocessingml")) return "docx";
  if (contentType?.includes("msword")) return "doc";
  if (contentType?.includes("rtf")) return "rtf";
  if (contentType?.includes("html")) return "html";
  return "pdf";
}

/** Formato por bytes mágicos, o null si no se reconoce ninguno. */
export function formatoPorBytes(buffer: Uint8Array | undefined): Formato | null {
  if (!buffer || buffer.length < 8) return null;
  const b = buffer;
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "pdf"; // %PDF
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return "docx"; // PK zip (OOXML)
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return "doc"; // OLE2 (Word 97)
  if (b[0] === 0x7b && b[1] === 0x5c && b[2] === 0x72 && b[3] === 0x74 && b[4] === 0x66) return "rtf"; // {\rtf
  const inicio = Buffer.from(b.subarray(0, 512)).toString("latin1").trimStart().toLowerCase();
  if (inicio.startsWith("<!doctype html") || inicio.startsWith("<html")) return "html";
  return null;
}

/** Formato por bytes mágicos; si no se reconocen, por extensión / content-type. */
export function formatoDe(url: string, contentType?: string | null, buffer?: Uint8Array): Formato {
  return formatoPorBytes(buffer) ?? porExtension(url, contentType);
}

async function conArchivoTemporal<T>(buffer: Uint8Array, ext: string, fn: (ruta: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "kb-texto-"));
  try {
    const ruta = join(dir, `doc.${ext}`);
    await writeFile(ruta, buffer);
    return await fn(ruta);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function correr(bin: string, args: string[], etiqueta: string, nota: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(bin, args, { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/ENOENT/.test(msg)) throw new Error(`${etiqueta}: ${nota} y aquí no está instalado ${bin} (sólo en la imagen del worker).`);
    throw new Error(`${etiqueta}: ${bin} falló — ${msg.slice(0, 160)}`);
  }
}

export async function extraerTexto(buffer: Uint8Array, formato: Formato, etiqueta: string): Promise<string> {
  switch (formato) {
    case "pdf":
      return parsePdfBuffer(buffer, etiqueta);
    case "docx": {
      const mammoth = await import("mammoth");
      return (await mammoth.extractRawText({ buffer: Buffer.from(buffer) })).value;
    }
    case "doc": // antiword -w 0: texto plano sin envolver líneas
      return conArchivoTemporal(buffer, "doc", (ruta) => correr("antiword", ["-w", "0", ruta], etiqueta, "es un .doc de Word 97"));
    case "rtf": // unrtf --text: texto plano; quita el encabezado «### ...» que agrega
      return (await conArchivoTemporal(buffer, "rtf", (ruta) => correr("unrtf", ["--text", ruta], etiqueta, "es RTF"))).replace(/^###.*\n?/gm, "");
    case "html":
      return Buffer.from(buffer).toString("utf8").replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&aacute;/g, "á").replace(/&eacute;/g, "é").replace(/&iacute;/g, "í").replace(/&oacute;/g, "ó").replace(/&uacute;/g, "ú").replace(/&ntilde;/g, "ñ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ");
  }
}
