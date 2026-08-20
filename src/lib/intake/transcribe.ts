import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { deepgramConfigured } from "./config";
import { parseProductFromTopic, pickAudioFile, type ZoomRecordingPayload } from "./zoom";
import { transcribeAudio as whisperTranscribe, transcriptionConfigured as whisperConfigured } from "@/lib/whatsapp/transcribe";

// ─────────────────────────────────────────────────────────────────────────────
// Transcripción de grabaciones de Zoom → IntakeTranscript.
//
// Proveedor primario: Deepgram nova-2 (language=es, diarización) con keyword
// boosting del vocabulario fiscal — la transcripción genérica destroza CFDI,
// timbrado, PPD/PUE, complemento de pago… que son exactamente las palabras que
// cargan el pedido. Fallback: Whisper (ya en el stack para notas de voz), sin
// diarización. El vocabulario vive en config/vocabulary.es-mx.json y se edita
// por PR como cualquier archivo.
// ─────────────────────────────────────────────────────────────────────────────

export type TranscriptSegment = { speaker: string; start: number; end: number; text: string };

type Vocabulary = { keywords: { term: string; boost?: number }[] };

let vocabCache: Vocabulary | null = null;

export function loadVocabulary(): Vocabulary {
  if (vocabCache) return vocabCache;
  try {
    const file = path.join(process.cwd(), "config", "vocabulary.es-mx.json");
    vocabCache = JSON.parse(fs.readFileSync(file, "utf8")) as Vocabulary;
  } catch {
    vocabCache = { keywords: [] };
  }
  return vocabCache;
}

type DeepgramResult = {
  segments: TranscriptSegment[];
  fullText: string;
};

async function deepgramTranscribe(audio: Buffer, contentType: string): Promise<DeepgramResult> {
  const params = new URLSearchParams({
    model: "nova-2",
    language: "es",
    diarize: "true",
    utterances: "true",
    smart_format: "true",
    punctuate: "true",
  });
  for (const kw of loadVocabulary().keywords) {
    params.append("keywords", kw.boost ? `${kw.term}:${kw.boost}` : kw.term);
  }
  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
      "Content-Type": contentType,
    },
    body: new Uint8Array(audio),
  });
  if (!res.ok) {
    throw new Error(`Deepgram ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    results?: {
      utterances?: { speaker?: number; start: number; end: number; transcript: string }[];
      channels?: { alternatives?: { transcript?: string }[] }[];
    };
  };
  const utterances = json.results?.utterances ?? [];
  const segments: TranscriptSegment[] = utterances.map((u) => ({
    speaker: `S${u.speaker ?? 0}`,
    start: Math.round(u.start),
    end: Math.round(u.end),
    text: u.transcript,
  }));
  const fullText =
    segments.map((s) => s.text).join("\n") ||
    json.results?.channels?.[0]?.alternatives?.[0]?.transcript ||
    "";
  return { segments, fullText };
}

/** Descarga la grabación de Zoom usando el download_token del webhook. */
async function downloadZoomRecording(url: string, token: string | undefined): Promise<{ buffer: Buffer; contentType: string }> {
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Zoom download ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType: res.headers.get("content-type") ?? "audio/mp4" };
}

/**
 * Procesa las grabaciones de Zoom pendientes (RawIntake source=ZOOM sin
 * processedAt). Una por corrida por defecto — el audio de 40 min es el paso
 * pesado; el ritmo adaptativo del scheduler vuelve enseguida si quedó más.
 */
export async function runTranscribePending(limit = 2): Promise<{ transcribed: number; failed: number; pending: number }> {
  const rows = await prisma.rawIntake.findMany({
    where: { source: "ZOOM", processedAt: null },
    orderBy: { receivedAt: "asc" },
    take: limit,
  });
  let transcribed = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const payload = row.payload as ZoomRecordingPayload;
      const meeting = payload.object ?? {};
      const file = pickAudioFile(meeting.recording_files);
      if (!file?.download_url) throw new Error("recording.completed sin archivo de audio descargable");

      const { buffer, contentType } = await downloadZoomRecording(file.download_url, payload.download_token);

      let provider: string;
      let segments: TranscriptSegment[];
      let fullText: string;
      if (deepgramConfigured()) {
        provider = "deepgram";
        ({ segments, fullText } = await deepgramTranscribe(buffer, contentType));
      } else if (whisperConfigured()) {
        provider = "whisper";
        fullText = await whisperTranscribe(buffer, contentType);
        segments = fullText ? [{ speaker: "S0", start: 0, end: (meeting.duration ?? 0) * 60, text: fullText }] : [];
      } else {
        throw new Error("Sin proveedor de transcripción (DEEPGRAM_API_KEY u OPENAI_API_KEY)");
      }
      if (!fullText.trim()) throw new Error("Transcripción vacía");

      await prisma.$transaction([
        prisma.intakeTranscript.create({
          data: {
            rawIntakeId: row.id,
            meetingTopic: meeting.topic ?? null,
            productHint: parseProductFromTopic(meeting.topic),
            startedAt: meeting.start_time ? new Date(meeting.start_time) : null,
            durationSec: meeting.duration != null ? meeting.duration * 60 : null,
            participants: meeting.host_email ? [{ email: meeting.host_email, rol: "host" }] : undefined,
            provider,
            segments: segments as object[],
            fullText,
          },
        }),
        prisma.rawIntake.update({
          where: { id: row.id },
          data: { processedAt: new Date(), processError: null },
        }),
      ]);
      transcribed++;
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[intake] transcribe failed", row.id, msg);
      // El error queda en la fila (visible, re-procesable); processedAt se
      // marca para no reintentar en bucle un download_token ya vencido.
      await prisma.rawIntake.update({
        where: { id: row.id },
        data: { processedAt: new Date(), processError: msg.slice(0, 500) },
      });
    }
  }

  const pending = await prisma.rawIntake.count({ where: { source: "ZOOM", processedAt: null } });
  return { transcribed, failed, pending };
}
