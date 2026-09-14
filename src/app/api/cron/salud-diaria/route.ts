import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { horaLocalMx } from "@/lib/notificaciones";
import { correrSaludDiaria } from "@/lib/salud/snapshot";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/salud-diaria
//
// La foto diaria de salud de toda la cartera: ocho dimensiones por empresa
// (datos del SAT, credenciales, cumplimiento, declaraciones, contabilidad
// electrónica, IVA de flujo, bancos, hallazgos), el diff contra la foto
// anterior y la marca de quién requiere atención hoy.
//
// Sin modelo: es código determinista mirando a todas las empresas. Lo caro
// —razonar— se reserva para las que esta pasada marcó, que son pocas.
//
// Corre a partir de las 06:00 MX para que quien abra la app en la mañana ya
// encuentre la foto del día, y una vez al día por empresa (día local MX, por el
// único índice de SaludSnapshot).
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

  // La ventana se revisa ANTES de tomar el candado: si no toca correr, no hay
  // por qué disputarlo con el tick que sí va a trabajar.
  if (!force && horaLocalMx() < HORA_INICIO_MX) {
    return NextResponse.json({ ok: true, skipped: "fuera de ventana", procesadas: 0 });
  }

  return withCronLock("salud-diaria", async () => {
    const r = await correrSaludDiaria({ force, companyId });
    return NextResponse.json({ ok: true, ...r });
  });
}

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}
