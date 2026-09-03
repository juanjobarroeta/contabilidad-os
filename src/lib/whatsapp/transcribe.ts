import { recordWhisperCost, type CostCtx } from "@/lib/costos/record";
// ─────────────────────────────────────────────────────────────────────────────
// Voice-note transcription (OpenAI Whisper via fetch — no SDK).
//
// Twilio delivers WhatsApp voice notes as audio media (usually audio/ogg with
// the Opus codec). We send the bytes to Whisper and get back Spanish text,
// which the webhook then treats exactly like a typed message.
//
// Gated on OPENAI_API_KEY. If unset, transcriptionConfigured() is false and the
// webhook politely declines voice notes (current behavior) instead of erroring.
// ─────────────────────────────────────────────────────────────────────────────

export function transcriptionConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

const EXT_BY_TYPE: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/amr": "amr",
  "audio/wav": "wav",
  "audio/webm": "webm",
};

/** Transcribe an audio buffer to text (Spanish). Returns "" on failure. */
export async function transcribeAudio(
  buffer: Buffer,
  contentType: string,
  cost?: CostCtx,
): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return "";
  // Whisper cobra por minuto de audio y no devuelve la duración. Una nota de
  // voz de WhatsApp (OGG/Opus, ~16 kbps) pesa ~2 KB por segundo: se estima la
  // duración por tamaño para que el gasto entre a CostEvent y a los topes.
  const segundosEstimados = Math.max(1, Math.round(buffer.byteLength / 2000));
  void recordWhisperCost(segundosEstimados, { ...cost, subtipo: cost?.subtipo ?? "whatsapp.whisper" });

  const ext = EXT_BY_TYPE[contentType.split(";")[0].trim().toLowerCase()] ?? "ogg";
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(buffer)], { type: contentType || "audio/ogg" }),
    `nota.${ext}`
  );
  form.append("model", "whisper-1");
  form.append("language", "es");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) {
    console.error("[transcribe] whisper failed", res.status, await res.text().catch(() => ""));
    return "";
  }
  const json = (await res.json()) as { text?: string };
  return (json.text ?? "").trim();
}
