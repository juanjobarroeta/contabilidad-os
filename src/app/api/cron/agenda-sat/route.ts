import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { revisarPendientes } from "@/lib/agenda-sat/ejecutar";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/agenda-sat   [?max=N]
//
// La agenda del SAT: siembra las filas del mes (idempotente) y revisa las que
// ya tocaban — acuse mensual y opinión 32-D/CSF vía SatGo; balanza de CE
// contra la base (la baja el ce-worker). La cadencia de cada fila la decide
// src/lib/agenda-sat/calendario.ts, así que un tick sin nada que tocar es un
// no-op barato. Auth: CRON_SECRET.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}

async function handle(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const maxParam = parseInt(new URL(req.url).searchParams.get("max") ?? "6", 10);
  const max = Number.isFinite(maxParam) ? Math.min(Math.max(maxParam, 1), 40) : 6;
  try {
    const r = await revisarPendientes({ max });
    if (r.procesadas || r.sembradas || r.errores.length) {
      console.log(
        `[agenda-sat] sembradas=${r.sembradas} procesadas=${r.procesadas} pendientes=${r.pendientes} ` +
          Object.entries(r.porResultado).map(([k, v]) => `${k}=${v}`).join(" ") +
          (r.errores.length ? ` · errores: ${r.errores.slice(0, 5).join(" | ")}` : ""),
      );
    }
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[agenda-sat] falló:", error);
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}

export async function POST(req: Request) {
  return withCronLock("cron:agenda-sat", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:agenda-sat", () => handle(req));
}
