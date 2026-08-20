import { Prisma } from "@prisma/client";
import type { IntakeSource } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { intakeEnabled } from "./config";

// ─────────────────────────────────────────────────────────────────────────────
// Capa de captura: escribir el payload crudo y NADA más. El UNIQUE
// (source, externalId) absorbe los reintentos del proveedor (Twilio/Zoom
// reenvían ante timeouts) — un duplicado no es error, es el guard funcionando.
// ─────────────────────────────────────────────────────────────────────────────

export async function recordRawIntake(input: {
  source: IntakeSource;
  externalId: string;
  payload: Prisma.InputJsonValue;
}): Promise<"created" | "duplicate"> {
  try {
    await prisma.rawIntake.create({
      data: { source: input.source, externalId: input.externalId, payload: input.payload },
    });
    return "created";
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return "duplicate";
    }
    throw e;
  }
}

/**
 * Tap del webhook de WhatsApp (Twilio): registra el mensaje entrante para el
 * pipeline de intake. Fire-and-forget desde el webhook — NUNCA debe romper ni
 * retrasar la respuesta a Twilio, por eso traga sus propios errores.
 */
export async function captureWhatsappInbound(input: {
  messageSid: string;
  phone: string;
  body: string;
  profileName?: string | null;
  /** true cuando `body` es la transcripción de una nota de voz. */
  esTranscripcion?: boolean;
}): Promise<void> {
  if (!intakeEnabled()) return;
  if (!input.messageSid || !input.body.trim()) return;
  try {
    await recordRawIntake({
      source: "WHATSAPP",
      // Las notas de voz llegan con el MISMO MessageSid que su evento de media;
      // el sufijo evita chocar con una captura previa del mismo SID.
      externalId: input.esTranscripcion ? `${input.messageSid}:voice` : input.messageSid,
      payload: {
        phone: input.phone,
        body: input.body,
        profileName: input.profileName ?? null,
        esTranscripcion: input.esTranscripcion ?? false,
      },
    });
  } catch (e) {
    console.error("[intake] captureWhatsappInbound failed", e);
  }
}
