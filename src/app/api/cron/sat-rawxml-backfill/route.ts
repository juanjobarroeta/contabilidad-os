import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { submitSatSync, verifyAndImportSatSync } from "@/lib/sat-sync";

// ─────────────────────────────────────────────────────────────────────────────
// POST (or GET) /api/cron/sat-rawxml-backfill
//
// One-off repair: populate Invoice.rawXml for CFDIs imported before we started
// storing the original XML. Finds the periods (year-month) that still have
// invoices missing rawXml, re-submits + re-imports those periods from SAT
// (force, to bypass the 24h reuse short-circuit), and the import path backfills
// rawXml on the existing rows. Quota-paced like the historical backfill.
//
// Auth: CRON_SECRET (Bearer or x-cron-secret), same as the other crons.
// Safe to re-run; no-ops once every invoice has its rawXml.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_PERIODS_PER_RUN = 6; // 6 periods × 2 tipos ≈ within SAT quota per run

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
  const onlyCompanyId = url.searchParams.get("companyId"); // optional scope
  const startedAt = Date.now();

  // Companies with a FIEL (needed to query SAT) and at least one invoice
  // missing rawXml.
  const companies = await prisma.company.findMany({
    where: {
      isActive: true,
      fielCer: { not: null },
      fielKey: { not: null },
      fielPassword: { not: null },
      ...(onlyCompanyId ? { id: onlyCompanyId } : {}),
      invoices: { some: { uuid: { not: null }, rawXml: null } },
    },
    select: { id: true, rfc: true },
  });

  let totalImported = 0;
  const perCompany: Array<{ rfc: string; periods: number; remaining: number }> = [];
  const errors: Array<{ companyId: string; rfc: string; error: string }> = [];

  for (const company of companies) {
    try {
      // Distinct (year, month) periods that still have invoices without rawXml.
      const missing = await prisma.invoice.findMany({
        where: { companyId: company.id, uuid: { not: null }, rawXml: null },
        select: { fecha: true },
      });
      const periodSet = new Set<string>();
      for (const inv of missing) {
        periodSet.add(`${inv.fecha.getFullYear()}-${inv.fecha.getMonth() + 1}`);
      }
      const periods = [...periodSet]
        .map((p) => {
          const [y, m] = p.split("-").map(Number);
          return { year: y, month: m };
        })
        // Newest first, capped per run for SAT quota.
        .sort((a, b) => b.year - a.year || b.month - a.month)
        .slice(0, MAX_PERIODS_PER_RUN);

      for (const { year, month } of periods) {
        const submitted = await submitSatSync(company.id, year, month, true); // force re-request
        if (!submitted.ok) {
          if (submitted.error.includes("5002")) break; // quota — resume next run
          continue;
        }
        const verified = await verifyAndImportSatSync(
          company.id,
          submitted.emitidosRequestId,
          submitted.recibidosRequestId
        );
        if (verified.ok && typeof verified.imported === "number") {
          totalImported += verified.imported;
        }
      }

      const remaining = await prisma.invoice.count({
        where: { companyId: company.id, uuid: { not: null }, rawXml: null },
      });
      perCompany.push({ rfc: company.rfc, periods: periods.length, remaining });
    } catch (e) {
      console.error(`[cron/sat-rawxml-backfill] company ${company.id} failed:`, e);
      errors.push({ companyId: company.id, rfc: company.rfc, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const summary = {
    ok: true,
    companies: companies.length,
    importedOrBackfilled: totalImported,
    perCompany,
    errors,
    elapsedMs: Date.now() - startedAt,
    note: "Re-run until every company's 'remaining' is 0. SAT packages are async — rawXml fills as packages finish.",
  };
  console.log("[cron/sat-rawxml-backfill] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
