import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { horaLocalMx } from "@/lib/notificaciones";
import { correrPasadaDiaria } from "@/lib/contador/pasada";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/contador-pasada
//
// La revisión que nadie pidió: para cada empresa que la foto de salud marcó
// —cambió a peor, está bloqueada, o arrastra un compromiso abierto— el agente
// hace una pasada con los objetivos del contador y deja su resumen en el
// expediente.
//
// Es lo único caro del sistema. Corre DESPUÉS de la pasada de salud (07:00 MX
// contra sus 06:00) porque lee la foto del día: sin ella no hay a quién mirar
// y la corrida entera se omitiría.
//
// Auth: CRON_SECRET. Query: ?force=1, ?companyId=<id>, ?max=<n>.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const HORA_INICIO_MX = 7;

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
  const maxParam = Number(url.searchParams.get("max"));
  const max = Number.isFinite(maxParam) && maxParam > 0 ? maxParam : undefined;

  if (!force && horaLocalMx() < HORA_INICIO_MX) {
    return NextResponse.json({ ok: true, skipped: "fuera de ventana", corridas: 0 });
  }

  return withCronLock("contador-pasada", async () => {
    const r = await correrPasadaDiaria({ force, companyId, max });
    return NextResponse.json({ ok: true, ...r });
  });
}

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}
