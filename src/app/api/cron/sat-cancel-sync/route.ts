import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { syncCancelacionesPeriodo } from "@/lib/sat-sync";

// ─────────────────────────────────────────────────────────────────────────────
// POST (or GET) /api/cron/sat-cancel-sync
//
// Detecta CFDIs cancelados en el SAT (descarga de metadata) y revierte su
// efecto marcándolos CANCELLED — el motor fiscal deja de contarlos. Para cada
// empresa con FIEL, corre el mes actual + los `months-1` anteriores (default 3:
// las cancelaciones suelen ocurrir semanas/meses después de la emisión).
//
// Misma cadencia submit→verify que el sync de XML: SAT es asíncrono, así que un
// periodo puede quedar "pending" y resolverse en una corrida posterior. Seguro
// de re-ejecutar (idempotente: sólo STAMPED→CANCELLED).
//
// Auth: CRON_SECRET (Bearer o x-cron-secret), igual que los otros crons.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_MONTHS_BACK = 3;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
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
  const monthsParam = parseInt(url.searchParams.get("months") ?? "", 10);
  const monthsBack = Number.isFinite(monthsParam) ? Math.min(Math.max(monthsParam, 1), 12) : DEFAULT_MONTHS_BACK;
  const onlyCompanyId = url.searchParams.get("companyId");
  // dryRun: descarga y reporta qué cancelaría, SIN escribir — para validar el
  // formato del metadata contra una cancelación conocida antes de confiar.
  const dryRun = ["1", "true", "yes"].includes((url.searchParams.get("dryRun") ?? "").toLowerCase());
  const startedAt = Date.now();

  const companies = await prisma.company.findMany({
    where: {
      isActive: true,
      fielCer: { not: null },
      fielKey: { not: null },
      fielPassword: { not: null },
      ...(onlyCompanyId ? { id: onlyCompanyId } : {}),
    },
    select: { id: true, rfc: true },
  });

  const now = new Date();
  const periods: Array<{ year: number; month: number }> = [];
  for (let i = 0; i < monthsBack; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    periods.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }

  let companiesProcessed = 0;
  let totalCancelled = 0;
  let totalWouldCancel = 0;
  const errors: Array<{ companyId: string; rfc: string; error: string }> = [];

  for (const company of companies) {
    try {
      for (const { year, month } of periods) {
        const res = await syncCancelacionesPeriodo(company.id, year, month, dryRun);
        if (res.ok && res.cancelled) totalCancelled += res.cancelled;
        if (res.ok && res.wouldCancel) totalWouldCancel += res.wouldCancel.length;
        if (!res.ok && res.error) {
          errors.push({ companyId: company.id, rfc: company.rfc, error: res.error });
        }
      }
      companiesProcessed++;
    } catch (e) {
      errors.push({ companyId: company.id, rfc: company.rfc, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const summary = {
    ok: true,
    dryRun,
    companies: companies.length,
    companiesProcessed,
    ...(dryRun ? { wouldCancelDetected: totalWouldCancel } : { cancelledDetected: totalCancelled }),
    errors,
    elapsedMs: Date.now() - startedAt,
  };
  console.log("[cron/sat-cancel-sync] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
