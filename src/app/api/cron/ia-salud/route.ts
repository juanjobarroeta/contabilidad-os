import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { reportError } from "@/lib/observability";
import { clasificarFalloIa } from "@/lib/ia-salud";

// ─────────────────────────────────────────────────────────────────────────────
// GET/POST /api/cron/ia-salud — ¿puede el producto hablar con el modelo?
//
// El 13-sep-2026 la cuenta de Anthropic se quedó sin crédito y nos enteramos
// porque la abogada no podía trabajar: cada turno moría en un segundo con
// «Your credit balance is too low». Este cron hace la llamada más barata que
// existe (un token con Haiku) cada pocos minutos y, cuando falla por saldo,
// llave o saturación sostenida, lo reporta a Sentry con un fingerprint propio
// para que la alerta llegue al teléfono ANTES que el reclamo del cliente.
//
// Auth: CRON_SECRET (Bearer o x-cron-secret), igual que los otros crons.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MODELO = "claude-haiku-4-5-20251001";

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  if (req.headers.get("x-cron-secret") === secret) return true;
  return false;
}

async function handle(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!process.env.ANTHROPIC_API_KEY) {
    reportError(new Error("ANTHROPIC_API_KEY no está definida: el copiloto no puede responder."), { ruta: "cron/ia-salud", causa: "sin-llave" }, { level: "fatal", fingerprint: ["ia-salud", "sin-llave"] });
    return NextResponse.json({ ok: false, causa: "sin-llave" });
  }
  const t0 = Date.now();
  try {
    const r = await new Anthropic({ maxRetries: 0 }).messages.create({ model: MODELO, max_tokens: 1, messages: [{ role: "user", content: "ok" }] });
    return NextResponse.json({ ok: true, ms: Date.now() - t0, modelo: r.model });
  } catch (e) {
    const fallo = clasificarFalloIa(e);
    const ms = Date.now() - t0;
    if (fallo.alertar) {
      reportError(e, { ruta: "cron/ia-salud", causa: fallo.causa, ms }, { level: fallo.causa === "sin-credito" || fallo.causa === "llave-rechazada" ? "fatal" : "error", fingerprint: ["ia-salud", fallo.causa] });
    }
    return NextResponse.json({ ok: false, causa: fallo.causa, alertado: fallo.alertar, ms, detalle: fallo.detalle });
  }
}

export const GET = handle;
export const POST = handle;
