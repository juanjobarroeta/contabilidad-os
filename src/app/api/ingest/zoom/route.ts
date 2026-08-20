import { NextResponse } from "next/server";
import { recordRawIntake } from "@/lib/intake/ingest";
import { intakeEnabled, zoomConfigured } from "@/lib/intake/config";
import { verifyZoomSignature, zoomEncryptToken, type ZoomRecordingPayload } from "@/lib/intake/zoom";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ingest/zoom — webhook de Zoom (recording.completed).
//
// Regla de oro del ingest: verificar firma, escribir el payload crudo en
// RawIntake y responder 200 YA. Nada de procesamiento inline — Zoom
// deshabilita endpoints que no contestan rápido, y ese fallo es silencioso.
// El download_token viaja en el payload y se persiste con él (expira).
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const secret = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;
  if (!zoomConfigured() || !secret) {
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }

  const raw = await req.text();

  let body: { event?: string; payload?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  // Reto de validación del endpoint (lo manda al configurar y periódicamente).
  if (body.event === "endpoint.url_validation") {
    const plainToken = (body.payload as { plainToken?: string })?.plainToken ?? "";
    return NextResponse.json({ plainToken, encryptedToken: zoomEncryptToken(plainToken, secret) });
  }

  // Eventos reales: firma obligatoria.
  if (
    !verifyZoomSignature(raw, req.headers.get("x-zm-request-timestamp"), req.headers.get("x-zm-signature"), secret)
  ) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  if (body.event !== "recording.completed") {
    return NextResponse.json({ ok: true, ignored: body.event });
  }
  if (!intakeEnabled()) {
    // Firmado y válido, pero la captura está apagada: 200 para no acumular
    // reintentos de Zoom.
    return NextResponse.json({ ok: true, ignored: "intake disabled" });
  }

  const payload = body.payload as ZoomRecordingPayload;
  const uuid = payload?.object?.uuid;
  if (!uuid) return NextResponse.json({ error: "missing meeting uuid" }, { status: 400 });

  const result = await recordRawIntake({
    source: "ZOOM",
    externalId: uuid,
    payload: payload as object,
  });
  return NextResponse.json({ ok: true, result });
}
