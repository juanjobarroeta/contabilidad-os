import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { submitSatSync, verifyAndImportSatSync } from "@/lib/sat-sync";
import { notifyIvaChanges } from "@/lib/iva-change-notify";
import { notifyNewInvoices } from "@/lib/notify-new-invoices";
import { autoConciliarEmpresa } from "@/lib/bancos/auto-conciliar";

// ─────────────────────────────────────────────────────────────────────────────
// POST (or GET) /api/cron/sat-sync
//
// Background job that automatically syncs CFDIs from SAT for every eligible
// company — no user click required. Intended to be hit by a scheduled trigger
// (Railway Cron / external scheduler) a couple of times per day.
//
// Auth: NOT NextAuth. Protected by a shared secret in CRON_SECRET, passed as
//   Authorization: Bearer <secret>   or   x-cron-secret: <secret>
//
// For each eligible company it runs, for the current month + the previous
// `months-1` months (default 3 → covers late-arriving recibidos):
//   1. submitSatSync   — submit/reuse the SAT request (respects the 24h reuse
//                        window so we don't burn the per-RFC quota)
//   2. verifyAndImport — pick up any package SAT has finished preparing (this
//                        is also how packages submitted on a PREVIOUS run get
//                        imported once SAT finishes them)
//
// Periods before a company's fechaInicioOperaciones are skipped so brand-new
// RFCs don't waste quota querying months when they didn't yet exist.
//
// NOTE: this handles ongoing INCREMENTAL sync only. The one-time 5-year
// historical backfill is a separate (throttled) job — see roadmap.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
// Allow a long execution window — SAT calls are slow and we loop over companies.
export const maxDuration = 300;

const DEFAULT_MONTHS_BACK = 3;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed if not configured
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  if (req.headers.get("x-cron-secret") === secret) return true;
  return false;
}

/** Build the list of {year, month} periods to sync, newest first. */
function periodsToSync(monthsBack: number): Array<{ year: number; month: number }> {
  const out: Array<{ year: number; month: number }> = [];
  const now = new Date();
  for (let i = 0; i < monthsBack; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }
  return out;
}

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Optional ?months= override (clamped to a sane range)
  const url = new URL(req.url);
  const monthsParam = parseInt(url.searchParams.get("months") ?? "", 10);
  const monthsBack = Number.isFinite(monthsParam)
    ? Math.min(Math.max(monthsParam, 1), 12)
    : DEFAULT_MONTHS_BACK;

  const startedAt = Date.now();

  // Eligible companies: active, auto-sync on, and FIEL fully configured.
  const companies = await prisma.company.findMany({
    where: {
      isActive: true,
      autoSyncEnabled: true,
      fielCer: { not: null },
      fielKey: { not: null },
      fielPassword: { not: null },
    },
    select: { id: true, rfc: true, fechaInicioOperaciones: true },
  });

  const periods = periodsToSync(monthsBack);

  let companiesProcessed = 0;
  let totalImported = 0;
  let totalSubmitted = 0;
  let totalNotified = 0;
  let totalConciliated = 0;
  const errors: Array<{ companyId: string; rfc: string; error: string }> = [];

  for (const company of companies) {
    let companyTouched = false;
    // Mark the start so we can detect which CFDIs this run newly imported
    // (Invoice.createdAt >= companyRunStart) for the push digest below.
    const companyRunStart = new Date();
    try {
      for (const { year, month } of periods) {
        // Skip periods that end before the company started operating.
        if (company.fechaInicioOperaciones) {
          const monthEnd = new Date(year, month, 0, 23, 59, 59);
          if (monthEnd < company.fechaInicioOperaciones) continue;
        }

        const submitted = await submitSatSync(company.id, year, month);
        if (!submitted.ok) {
          // Period not complete yet (400) is expected/benign — skip quietly.
          if (submitted.status !== 400) {
            errors.push({ companyId: company.id, rfc: company.rfc, error: submitted.error });
          }
          continue;
        }
        companyTouched = true;
        if (!submitted.reusedEmitidos && submitted.emitidosRequestId) totalSubmitted++;
        if (!submitted.reusedRecibidos && submitted.recibidosRequestId) totalSubmitted++;

        // Pick up anything SAT has finished preparing (this run or a prior one).
        const verified = await verifyAndImportSatSync(
          company.id,
          submitted.emitidosRequestId,
          submitted.recibidosRequestId
        );
        if (verified.ok && typeof verified.imported === "number") {
          totalImported += verified.imported;
        }
      }

      if (companyTouched) {
        await prisma.company.update({
          where: { id: company.id },
          data: { lastAutoSyncAt: new Date() },
        });
        companiesProcessed++;

        // A freshly imported REP may have moved an unfiled period's IVA — let the
        // owner know (dormant unless IVA_CHANGE_NOTICE_ENABLED). Never fail the
        // sync over a notification problem.
        try {
          const notice = await notifyIvaChanges(company.id);
          totalNotified += notice.notified;
        } catch (e) {
          console.error(`[cron/sat-sync] iva-change notice failed for ${company.id}:`, e);
        }

        // Push digest of new facturas emitidas/recibidas (PWA + desktop).
        // Only fires on this incremental cron — never on the historical
        // backfill — so it stays a day-to-day "new invoices" alert.
        try {
          await notifyNewInvoices(company.id, companyRunStart);
        } catch (e) {
          console.error(`[cron/sat-sync] push notify failed for ${company.id}:`, e);
        }

        // Conciliación event-driven: con CFDIs frescos recién importados, corre
        // la auto-conciliación bancaria de alta confianza para esta empresa de
        // inmediato (no esperar al cron diario). Idempotente — sólo toca
        // transacciones UNMATCHED. Best-effort: nunca rompe el sync.
        try {
          const conc = await autoConciliarEmpresa(company.id);
          totalConciliated += conc.matched;
        } catch (e) {
          console.error(`[cron/sat-sync] auto-conciliar failed for ${company.id}:`, e);
        }
      }
    } catch (e) {
      console.error(`[cron/sat-sync] company ${company.id} failed:`, e);
      errors.push({
        companyId: company.id,
        rfc: company.rfc,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const summary = {
    ok: true,
    companiesEligible: companies.length,
    companiesProcessed,
    monthsBack,
    submitted: totalSubmitted,
    imported: totalImported,
    notified: totalNotified,
    conciliated: totalConciliated,
    errors,
    elapsedMs: Date.now() - startedAt,
  };
  console.log("[cron/sat-sync] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return handle(req);
}

// Allow GET too — many schedulers can only issue a GET against a URL.
export async function GET(req: Request) {
  return handle(req);
}
