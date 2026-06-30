import { NextResponse } from "next/server";
import { periodoMesAnterior } from "@/lib/contabilidad/ce-reconciliacion";
import { notificarCEEmpresa, notificarCETodas } from "@/lib/notify-ce";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/ce-reconciliacion   [?companyId=<id>] [?periodo=YYYY-MM]
//
// Cierre MENSUAL de Contabilidad Electrónica (presentación ASISTIDA, SÓLO
// LECTURA del ledger): para el mes cerrado anterior, en cada empresa con plan
// Syntage y ya arrancada (ceBootstrapAt != null):
//   1. ASEGURA los XML del Anexo 24 (catálogo + balanza) desde el libro vivo
//      — sólo se generan, NUNCA se envían al SAT.
//   2. CONCILIA la balanza del SAT (Syntage) contra la nuestra y levanta/
//      actualiza/resuelve el Hallazgo por empresa+periodo (reutiliza
//      reconciliarCEEmpresa).
//   3. EMPUJA un push a quienes operan la empresa: "lista para presentar"
//      (cuadra) o "no cuadra en N cuentas — revísala antes de presentar".
// No hay API de envío al SAT: se genera + guía, jamás se auto-presenta.
//
// Auth: secreto compartido en CRON_SECRET (Authorization: Bearer <secret> o
// x-cron-secret: <secret>).
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
  const only = url.searchParams.get("companyId");
  const periodo = url.searchParams.get("periodo") ?? periodoMesAnterior();

  try {
    if (only) {
      return NextResponse.json({ ok: true, ...(await notificarCEEmpresa(only, periodo)) });
    }
    return NextResponse.json({ ok: true, ...(await notificarCETodas(periodo)) });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}
