import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { horaLocalMx } from "@/lib/notificaciones";
import { correrPaseDiario } from "@/lib/cierre/pase-diario";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/cierre-avance
//
// El pase diario del cierre guiado: para cada empresa con plan, evalúa los
// periodos en juego, avisa lo que empeoró (inbox + chat del periodo + push
// si urge) y deja el snapshot para mañana. Sin modelo. Una vez al día por
// empresa (día local MX) y sólo a partir de las 06:00 MX, para que el digest
// de WhatsApp de las 08:00 (Actions) lo recoja.
//
// Auth: CRON_SECRET. Query: ?force=1 (repite hoy), ?companyId=<id>.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const HORA_INICIO_MX = 6;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed if not configured
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  const companyId = url.searchParams.get("companyId") ?? undefined;

  if (!force && horaLocalMx() < HORA_INICIO_MX) {
    return NextResponse.json({ ok: true, skipped: "fuera de ventana", procesadas: 0 });
  }

  return withCronLock("cierre-avance", async () => {
    const r = await correrPaseDiario({ force, companyId });
    return NextResponse.json({ ok: true, ...r });
  });
}

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}
