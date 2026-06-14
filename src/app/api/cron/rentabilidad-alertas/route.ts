import { NextResponse } from "next/server";
import { notifyRentabilidadAlertas } from "@/lib/costos/alertas";

// POST (o GET) /api/cron/rentabilidad-alertas
// Avisa a los operadores de los clientes "bajo agua" (costo > precio) del mes
// anterior. Auth: CRON_SECRET. Pensado para correr una vez al mes (tras cerrar
// el mes), aunque es idempotente — el tag colapsa avisos repetidos.

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}

async function handle(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ ok: true, ...(await notifyRentabilidadAlertas()) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
