import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { generarRecurrentesPendientes } from "@/lib/facturas/recurrentes-generar";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/facturas-recurrentes
//
// Genera las PREFACTURAS de las series recurrentes que vencen hoy. No timbra:
// deja borradores para que alguien los revise y los timbre (un CFDI timbrado
// consume timbre y sólo se deshace cancelándolo ante el SAT).
//
// Idempotente por construcción: crear el borrador y adelantar la serie ocurren
// en la misma transacción, así que una segunda corrida el mismo día ya no ve la
// serie vencida. Una serie muy atrasada avanza UN periodo por corrida — el cron
// diario se pone al corriente solo, sin inundar la bandeja de golpe.
//
// Auth: secreto compartido en CRON_SECRET, como
//   Authorization: Bearer <secret>   o   x-cron-secret: <secret>
//
// Query opcional: ?companyId=<id> para acotar a una empresa.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed si no está configurado
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  if (req.headers.get("x-cron-secret") === secret) return true;
  return false;
}

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const only = new URL(req.url).searchParams.get("companyId") ?? undefined;
  const res = await generarRecurrentesPendientes(new Date(), only);

  return NextResponse.json({ ok: true, ...res });
}

export async function POST(req: Request) {
  return withCronLock("cron:facturas-recurrentes", () => handle(req));
}

export async function GET(req: Request) {
  return withCronLock("cron:facturas-recurrentes", () => handle(req));
}
