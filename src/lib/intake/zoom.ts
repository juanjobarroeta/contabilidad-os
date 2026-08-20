import crypto from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Zoom webhooks — verificación y parseo (funciones puras, testeadas).
//
// Zoom manda dos cosas por el mismo endpoint:
//   · `endpoint.url_validation` al configurar: hay que responder el HMAC del
//     plainToken con el Secret Token de la app.
//   · Eventos reales (`recording.completed`) firmados con
//     x-zm-signature = "v0=" + HMAC_SHA256(secret, "v0:{ts}:{rawBody}").
// ─────────────────────────────────────────────────────────────────────────────

export function zoomEncryptToken(plainToken: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(plainToken).digest("hex");
}

export function verifyZoomSignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  secret: string
): boolean {
  if (!timestamp || !signature) return false;
  const expected = `v0=${crypto.createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export type ZoomRecordingFile = {
  file_type?: string; // "M4A" | "MP4" | "TRANSCRIPT" | …
  recording_type?: string; // "audio_only" | "shared_screen_with_speaker_view" | …
  download_url?: string;
  file_size?: number;
};

export type ZoomRecordingPayload = {
  download_token?: string;
  object?: {
    uuid?: string;
    topic?: string;
    start_time?: string;
    duration?: number; // minutos
    host_email?: string;
    recording_files?: ZoomRecordingFile[];
  };
};

/**
 * Elige el archivo a transcribir: audio-only (M4A) primero — es el más chico —
 * y si no existe, el MP4 principal.
 */
export function pickAudioFile(files: ZoomRecordingFile[] | undefined): ZoomRecordingFile | null {
  if (!files?.length) return null;
  const audio = files.find((f) => f.file_type?.toUpperCase() === "M4A" && f.download_url);
  if (audio) return audio;
  return files.find((f) => f.file_type?.toUpperCase() === "MP4" && f.download_url) ?? null;
}

/**
 * Atribución casi gratis: la convención de nombres de reunión
 * "[PRODUCTO] Cliente — propósito" (p. ej. "[CONTABILIDADOS] Despacho Reyes —
 * onboarding"). Devuelve el tag en minúsculas, o null si no sigue la convención.
 */
export function parseProductFromTopic(topic: string | null | undefined): string | null {
  const m = /^\s*\[([A-Za-zÁÉÍÓÚÑáéíóúñ0-9_-]+)\]/.exec(topic ?? "");
  return m ? m[1].toLowerCase() : null;
}
