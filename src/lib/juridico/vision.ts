// ─────────────────────────────────────────────────────────────────────────────
// Transcripción con visión: fotos de un contrato (JPEG/PNG/WebP/GIF) y PDF
// escaneados (sin capa de texto) se convierten a texto pidiéndoselo al modelo,
// que los ve como imágenes / documento. Sin OCR aparte: el modelo lee mejor
// una foto torcida de un contrato que tesseract, y el texto que sale entra al
// mismo índice de secciones que un PDF normal (documentos.ts).
//
// Límites del API: 5 MB por imagen (el satélite reduce las fotos del teléfono
// antes de subirlas), PDF de hasta 100 páginas / 32 MB. La salida larga se
// pide por rondas («continúa») hasta que el modelo termina solo.
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import { recordLlmCost, type CostCtx } from "@/lib/costos/record";

export type MediaImagen = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export const MAX_BYTES_IMAGEN = 5 * 1024 * 1024;
export const MAX_BYTES_PDF_VISION = 32 * 1024 * 1024;
export const MAX_PAGINAS_PDF_VISION = 100;
export const MAX_IMAGENES_POR_DOCUMENTO = 40;

const MODELO = process.env.AI_OCR_MODEL ?? "claude-sonnet-5";
const MODELO_RESPALDO = "claude-haiku-4-5-20251001";
const MAX_RONDAS = 8;

/** Tipo de imagen por bytes mágicos, o null si no es una imagen que el API acepte. */
export function tipoImagen(b: Uint8Array): MediaImagen | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

/** HEIC/HEIF (fotos de iPhone sin convertir): el API no las acepta; se avisa con claridad. */
export function esHeic(b: Uint8Array): boolean {
  if (b.length < 12) return false;
  const marca = Buffer.from(b.subarray(4, 12)).toString("latin1");
  return marca.startsWith("ftyp") && /heic|heix|hevc|heif|mif1/.test(marca.slice(4));
}

const PAGINAS_POR_LOTE = 4;
const LOTES_EN_PARALELO = 4;

const instruccion = (primeraPagina: number) => `Transcribe íntegro y en orden todo el texto legible de este documento (un contrato, un escrito, un acta, una demanda…).
- Conserva la numeración de cláusulas, artículos, fracciones e incisos, los títulos y los saltos de párrafo.
- Empieza cada página con una línea «— Página N —», numerando desde la ${primeraPagina}.
- Lo que no se lea escríbelo como [ilegible]; una firma o sello, como [firma] o [sello].
- No resumas, no comentes, no traduzcas, no corrijas la redacción ni completes lo que no está: sólo el texto tal cual.`;

type Parte = { tipo: "imagen"; media: MediaImagen; data: Uint8Array } | { tipo: "pdf"; data: Uint8Array };

/**
 * Texto transcrito de una o varias fotos (un documento) o de un PDF escaneado.
 * Un modelo tarda ~15 s por página, así que se transcribe por lotes de 4
 * páginas en paralelo (un PDF se parte con pdf-lib) y se concatena en orden.
 */
export async function transcribirConVision(anthropic: Anthropic, partes: Parte[], opts: { etiqueta: string; cost: CostCtx }): Promise<{ texto: string; modelo: string; rondas: number }> {
  const lotes = await partirEnLotes(partes);
  if (lotes.length <= 1) return transcribirLote(anthropic, partes, 1, opts);
  const resultados: { texto: string; modelo: string; rondas: number }[] = new Array(lotes.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(LOTES_EN_PARALELO, lotes.length) }, async () => {
      for (;;) {
        const k = i++;
        if (k >= lotes.length) return;
        resultados[k] = await transcribirLote(anthropic, lotes[k].partes, lotes[k].primeraPagina, opts);
      }
    })
  );
  return { texto: resultados.map((r) => r.texto).join("\n\n"), modelo: resultados[0].modelo, rondas: resultados.reduce((a, r) => a + r.rondas, 0) };
}

async function partirEnLotes(partes: Parte[]): Promise<{ partes: Parte[]; primeraPagina: number }[]> {
  if (partes.every((p) => p.tipo === "imagen")) {
    const lotes = [];
    for (let k = 0; k < partes.length; k += PAGINAS_POR_LOTE) lotes.push({ partes: partes.slice(k, k + PAGINAS_POR_LOTE), primeraPagina: k + 1 });
    return lotes;
  }
  if (partes.length === 1 && partes[0].tipo === "pdf") {
    try {
      const { PDFDocument } = await import("pdf-lib");
      const origen = await PDFDocument.load(partes[0].data, { ignoreEncryption: true });
      const total = origen.getPageCount();
      if (total <= PAGINAS_POR_LOTE) return [{ partes, primeraPagina: 1 }];
      const lotes = [];
      for (let k = 0; k < total; k += PAGINAS_POR_LOTE) {
        const sub = await PDFDocument.create();
        const idx = Array.from({ length: Math.min(PAGINAS_POR_LOTE, total - k) }, (_, j) => k + j);
        for (const pg of await sub.copyPages(origen, idx)) sub.addPage(pg);
        lotes.push({ partes: [{ tipo: "pdf" as const, data: await sub.save() }], primeraPagina: k + 1 });
      }
      return lotes;
    } catch {
      return [{ partes, primeraPagina: 1 }]; // pdf-lib no lo pudo partir: entero, en una sola llamada
    }
  }
  return [{ partes, primeraPagina: 1 }];
}

async function transcribirLote(anthropic: Anthropic, partes: Parte[], primeraPagina: number, opts: { etiqueta: string; cost: CostCtx }): Promise<{ texto: string; modelo: string; rondas: number }> {
  const bloques: Anthropic.ContentBlockParam[] = partes.map((p) =>
    p.tipo === "imagen"
      ? { type: "image", source: { type: "base64", media_type: p.media, data: Buffer.from(p.data).toString("base64") } }
      : { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(p.data).toString("base64") } }
  );
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: [...bloques, { type: "text", text: instruccion(primeraPagina) }] }];
  let modelo = MODELO;
  let texto = "";
  let rondas = 0;
  for (; rondas < MAX_RONDAS; ) {
    let res: Anthropic.Message;
    try {
      res = await anthropic.messages.create({ model: modelo, max_tokens: 16_000, messages, system: "Eres un transcriptor de documentos jurídicos: fiel, completo, sin opinar." });
    } catch (err) {
      if (modelo !== MODELO_RESPALDO && err instanceof Anthropic.NotFoundError) {
        modelo = MODELO_RESPALDO;
        continue;
      }
      throw err;
    }
    rondas++;
    await recordLlmCost(modelo, res.usage, { ...opts.cost, subtipo: "ai.juridico.ocr" });
    const trozo = res.content
      .filter((c): c is Anthropic.TextBlock => c.type === "text")
      .map((c) => c.text)
      .join("");
    texto += (texto && !texto.endsWith("\n") ? "\n" : "") + trozo;
    if (res.stop_reason !== "max_tokens") break;
    // Se cortó por longitud: el modelo sigue donde se quedó.
    messages.push({ role: "assistant", content: trozo }, { role: "user", content: "Continúa la transcripción exactamente donde te quedaste, sin repetir nada." });
  }
  return { texto: texto.trim(), modelo, rondas };
}
