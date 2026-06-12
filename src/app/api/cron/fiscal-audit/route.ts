import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { runAuditForCompany } from "@/lib/fiscal/audit/service";

// ─────────────────────────────────────────────────────────────────────────────
// POST (or GET) /api/cron/fiscal-audit
//
// The "24/7 contador": runs the fiscal auditor for every company and persists
// findings (FiscalHallazgo). Idempotent — safe to run on any cadence.
//
// Auth: shared secret in CRON_SECRET, passed as
//   Authorization: Bearer <secret>   or   x-cron-secret: <secret>
//
// Optional query: ?companyId=<id> to audit a single company.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed if not configured
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  if (req.headers.get("x-cron-secret") === secret) return true;
  return false;
}

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const only = url.searchParams.get("companyId");

  const companies = only
    ? [{ id: only }]
    : await prisma.company.findMany({ select: { id: true } });

  const resultados = [];
  let errores = 0;
  for (const c of companies) {
    try {
      resultados.push(await runAuditForCompany(c.id));
    } catch (e) {
      errores++;
      resultados.push({ companyId: c.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return NextResponse.json({
    ok: true,
    empresas: companies.length,
    errores,
    resultados,
  });
}

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}
