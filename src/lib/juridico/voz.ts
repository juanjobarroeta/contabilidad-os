// ─────────────────────────────────────────────────────────────────────────────
// Notas de voz del abogado.
//
// Un abogado dicta: es como trabaja desde siempre. Escribir en el teléfono los
// hechos de un asunto, o la instrucción de qué contestar, es la fricción que
// hace que no lo use en el juzgado ni en el coche.
//
// La nota NO se manda al copiloto directamente: se transcribe y el texto cae en
// el cuadro de escribir, para que el abogado lo corrija antes de enviarlo. Lo
// que dicta puede llevar nombres, cifras y plazos, y un dictado mal entendido
// que se manda solo es peor que teclear.
// ─────────────────────────────────────────────────────────────────────────────
import { transcribeAudio, transcriptionConfigured } from "@/lib/whatsapp/transcribe";

/** 25 MB es el tope de Whisper; con voz son de sobra ~20 minutos. */
export const MAX_BYTES_AUDIO = 25 * 1024 * 1024;

export const TIPOS_AUDIO = ["audio/ogg", "audio/mpeg", "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/wav", "audio/webm", "audio/aac", "video/mp4"] as const;

export function esAudio(tipo: string | null | undefined, nombre?: string): boolean {
  const t = (tipo ?? "").split(";")[0].trim().toLowerCase();
  if (t.startsWith("audio/")) return true;
  if ((TIPOS_AUDIO as readonly string[]).includes(t)) return true;
  return /\.(ogg|oga|mp3|m4a|wav|webm|aac|mp4)$/i.test(nombre ?? "");
}

export function transcripcionDisponible(): boolean {
  return transcriptionConfigured();
}

/**
 * Segundos aproximados de una nota, por su tamaño: Whisper no devuelve la
 * duración y el costo se cobra por minuto. Sirve para avisar y para medir.
 * Puro.
 */
export function segundosAproximados(bytes: number): number {
  return Math.max(1, Math.round(bytes / 2000));
}

export interface Transcripcion {
  texto: string;
  segundos: number;
  aviso?: string;
}

export async function transcribirNota(buffer: Buffer, contentType: string, ctx: { userId: string }): Promise<Transcripcion> {
  const segundos = segundosAproximados(buffer.byteLength);
  const texto = await transcribeAudio(buffer, contentType, { companyId: null, userId: ctx.userId, subtipo: "ai.juridico.voz" });
  if (!texto) {
    return { texto: "", segundos, aviso: "No se entendió la nota. Grábala otra vez, más cerca del micrófono." };
  }
  return { texto, segundos };
}
