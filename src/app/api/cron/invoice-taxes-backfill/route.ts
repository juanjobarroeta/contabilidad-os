import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseCfdiXml } from "@/lib/sat-fiel";

// ─────────────────────────────────────────────────────────────────────────────
// POST (or GET) /api/cron/invoice-taxes-backfill
//
// One-off repair: create InvoiceTax rows (desglose del nodo <cfdi:Impuestos>:
// traslados con TipoFactor Tasa/Exento + retenciones IVA/ISR) for invoices that
// already have rawXml but were imported before we parsed the breakdown. Purely
// local — parses the stored XML, no SAT round-trip — so it complements the
// rawXml backfill: as that one fills rawXml, this one fills the taxes.
//
// The desglose feeds retenciones acreditadas (10% Art. 106 / 1.25% Art. 113-J)
// and the IVA proporción de acreditamiento (Art. 5 LIVA).
//
// Safe to re-run. `remaining` converges to the count of CFDIs whose XML has no
// invoice-level Impuestos node (tipo P/T/N, actos no objeto) — a stable
// non-zero remaining is expected and correct.
//
// Auth: CRON_SECRET (Bearer or x-cron-secret), same as the other crons.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PAGE = 200;
const TIME_BUDGET_MS = 240_000; // leave headroom under maxDuration

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

  const where = {
    rawXml: { not: null },
    taxes: { none: {} },
    ...(onlyCompanyId ? { companyId: onlyCompanyId } : {}),
  } as const;

  let lastId: string | undefined;
  let scanned = 0;
  let repaired = 0;
  let sinDesglose = 0; // XML without an invoice-level Impuestos node — nothing to create

  while (Date.now() - startedAt < TIME_BUDGET_MS) {
    // Keyset pagination (id > lastId) instead of a Prisma cursor: repaired rows
    // drop out of the filter mid-sweep, so the cursor row may stop matching.
    const page = await prisma.invoice.findMany({
      where: { ...where, ...(lastId ? { id: { gt: lastId } } : {}) },
      select: { id: true, rawXml: true },
      orderBy: { id: "asc" },
      take: PAGE,
    });
    if (page.length === 0) break;

    for (const inv of page) {
      scanned++;
      try {
        const parsed = parseCfdiXml(inv.rawXml!);
        if (parsed.taxes.length === 0) {
          sinDesglose++;
          continue;
        }
        await prisma.invoiceTax.createMany({
          data: parsed.taxes.map((t) => ({ invoiceId: inv.id, ...t })),
        });
        repaired++;
      } catch (e) {
        console.error(`[cron/invoice-taxes-backfill] invoice ${inv.id} failed:`, e);
      }
    }

    lastId = page[page.length - 1].id;
    if (page.length < PAGE) break;
  }

  const remaining = await prisma.invoice.count({ where });

  const summary = {
    ok: true,
    scanned,
    repaired,
    sinDesglose,
    remaining,
    elapsedMs: Date.now() - startedAt,
    note: "Re-run until 'remaining' stabilizes — a stable remaining equals CFDIs whose XML has no invoice-level Impuestos node (P/T/N, no objeto), which is correct.",
  };
  console.log("[cron/invoice-taxes-backfill] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
