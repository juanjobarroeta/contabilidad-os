// ─────────────────────────────────────────────────────────────────────────────
// Captura asistida — transcripción de audio en el servidor (OpenAI).
//
// POST https://api.openai.com/v1/audio/transcriptions con fetch + FormData
// (sin SDK, como whatsapp/transcribe.ts): modelo gpt-4o-transcribe y, si ese
// modelo no está disponible para la cuenta, whisper-1. Audio de hasta 25 MB
// (el límite del proveedor) y 60 s de espera. El costo entra a CostEvent con
// `recordWhisperCost` (misma tarifa por minuto) para que lo vean los topes.
// El texto que sale es una PROPUESTA: el médico lo revisa antes de
// estructurarlo y de firmar.
// ─────────────────────────────────────────────────────────────────────────────

import { recordWhisperCost, type CostCtx } from "@/lib/costos/record";
import { HospitalError } from "../errores";

export const STT_MODELO = "gpt-4o-transcribe";
export const STT_MODELO_RESPALDO = "whisper-1";
export const STT_MAX_BYTES = 25 * 1024 * 1024;
export const STT_TIMEOUT_MS = 60_000;
const STT_URL = "https://api.openai.com/v1/audio/transcriptions";

/** Extensión con la que se manda el archivo (OpenAI la usa para detectar el formato). */
const EXT_POR_MIME: Record<string, string> = {
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac",
};

export function mimeAudioAdmitido(mime: string | null | undefined): boolean {
  return !!mime && EXT_POR_MIME[mime.split(";")[0].trim().toLowerCase()] !== undefined;
}

export function sttConfigurado(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

/** «es-MX» → «es»: la API acepta ISO-639-1. */
export function idiomaStt(idioma: string | null | undefined): string {
  const base = (idioma ?? "es").trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2}$/.test(base) ? base : "es";
}

export interface Transcripcion {
  texto: string;
  /** Segundos de audio según el proveedor; null si no los devolvió. */
  duracionSeg: number | null;
  modelo: string;
  proveedor: "openai";
}

export interface TranscribirOpciones {
  cost?: CostCtx;
  /** Para pruebas: reemplaza fetch. */
  fetchImpl?: typeof fetch;
  /** Para pruebas: la llave; default OPENAI_API_KEY. */
  apiKey?: string;
  timeoutMs?: number;
}

type RespuestaStt = { text?: string; duration?: number; usage?: { type?: string; seconds?: number } };

/**
 * Transcribe un audio. Lanza HospitalError: 413 si pasa de 25 MB, 415 si el
 * formato no se admite, 503 sin llave, 504 si el proveedor tarda más de 60 s,
 * 502 si falla.
 */
export async function transcribirAudio(buffer: Buffer, mime: string, idioma?: string | null, opciones: TranscribirOpciones = {}): Promise<Transcripcion> {
  const key = opciones.apiKey ?? process.env.OPENAI_API_KEY;
  if (!key) throw new HospitalError(503, "La transcripción en el servidor no está configurada (falta OPENAI_API_KEY)");
  if (buffer.byteLength === 0) throw new HospitalError(400, "El audio viene vacío");
  if (buffer.byteLength > STT_MAX_BYTES) throw new HospitalError(413, "El audio excede el límite de 25 MB: graba en segmentos más cortos");
  const tipo = mime.split(";")[0].trim().toLowerCase();
  const ext = EXT_POR_MIME[tipo];
  if (!ext) throw new HospitalError(415, `Formato de audio no admitido (${tipo || "desconocido"}): usa webm, ogg, m4a, mp3 o wav`);

  const fetchImpl = opciones.fetchImpl ?? fetch;
  const timeoutMs = opciones.timeoutMs ?? STT_TIMEOUT_MS;
  const lang = idiomaStt(idioma);

  const pedir = async (modelo: string): Promise<Response> => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(buffer)], { type: tipo }), `dictado.${ext}`);
    form.append("model", modelo);
    form.append("language", lang);
    // whisper-1 devuelve la duración en verbose_json; gpt-4o-transcribe la trae en usage.seconds.
    form.append("response_format", modelo === STT_MODELO_RESPALDO ? "verbose_json" : "json");
    try {
      return await fetchImpl(STT_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const nombre = (e as { name?: string })?.name;
      if (nombre === "TimeoutError" || nombre === "AbortError") {
        throw new HospitalError(504, "La transcripción tardó más de 60 segundos; graba un segmento más corto o dicta con el navegador");
      }
      throw new HospitalError(502, "No se pudo contactar al servicio de transcripción; dicta con el navegador");
    }
  };

  let modelo = STT_MODELO;
  let res = await pedir(modelo);
  if (!res.ok && (res.status === 404 || res.status === 400 || res.status === 403)) {
    // El modelo nuevo no está disponible para esta cuenta (o rechazó el formato): Whisper.
    modelo = STT_MODELO_RESPALDO;
    res = await pedir(modelo);
  }
  if (!res.ok) {
    const detalle = await res.text().catch(() => "");
    console.error("[hospital/asistente] transcripción falló", res.status, detalle.slice(0, 300));
    if (res.status === 429) throw new HospitalError(503, "El servicio de transcripción está saturado; inténtalo en un momento o dicta con el navegador");
    throw new HospitalError(502, "El servicio de transcripción rechazó el audio; dicta con el navegador");
  }
  const json = (await res.json().catch(() => ({}))) as RespuestaStt;
  const texto = (json.text ?? "").trim();
  const duracion = typeof json.usage?.seconds === "number" ? json.usage.seconds : typeof json.duration === "number" ? json.duration : null;

  // Costo por minuto de audio: si el proveedor no dijo la duración se estima
  // por tamaño (~16 kbps → 2 KB/s), como las notas de voz de WhatsApp.
  const segundosCobrados = duracion ?? Math.max(1, Math.round(buffer.byteLength / 2000));
  void recordWhisperCost(segundosCobrados, { ...opciones.cost, subtipo: opciones.cost?.subtipo ?? "hospital.asistente.transcribir" });

  if (!texto) throw new HospitalError(422, "No se reconoció voz en el audio; vuelve a grabar o dicta con el navegador");
  return { texto, duracionSeg: duracion == null ? null : Math.round(duracion), modelo, proveedor: "openai" };
}
