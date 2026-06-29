import { NextResponse } from "next/server";
import {
  reconciliarTodasCEEmpresas,
  reconciliarCEEmpresa,
  periodoMesAnterior,
} from "@/lib/contabilidad/ce-reconciliacion";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/ce-reconciliacion   [?companyId=<id>] [?periodo=YYYY-MM]
//
// Conciliación MENSUAL de Contabilidad Electrónica (SÓLO LECTURA): compara la
// balanza (BCE) que el SAT tiene en Syntage contra la balanza que generamos del
// libro vivo, para el mes cerrado anterior, en cada empresa con plan Syntage y
// ya arrancada (ceBootstrapAt != null). Levanta/actualiza/resuelve un Hallazgo
// por empresa+periodo. NUNCA escribe en el ledger.
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
      return NextResponse.json({ ok: true, ...(await reconciliarCEEmpresa(only, periodo)) });
    }
    return NextResponse.json({ ok: true, ...(await reconciliarTodasCEEmpresas(periodo)) });
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
