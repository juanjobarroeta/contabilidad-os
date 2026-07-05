import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import { crearActivoDesdeCfdiSiAplica } from "@/lib/fiscal/auto-activo";

// ─────────────────────────────────────────────────────────────────────────────
// POST (or GET) /api/cron/activos-backfill
//
// Crea el ActivoFijo de los CFDIs ya clasificados como INVERSION que aún no
// tienen activo (los que se importaron antes del auto-registro). Local, sin SAT.
// Idempotente (crearActivoDesdeCfdiSiAplica salta los que ya tienen activo).
//
// Auth: CRON_SECRET (Bearer o x-cron-secret), igual que los otros crons.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PAGE = 200;
const TIME_BUDGET_MS = 240_000;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  if (req.headers.get("x-cron-secret") === secret) return true;
  return false;
}

async function handle(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const onlyCompanyId = url.searchParams.get("companyId");
  const startedAt = Date.now();

  // EGRESO con naturaleza INVERSION y sin activo asociado.
  const where = {
    tipo: "EGRESO" as const,
    naturaleza: "INVERSION",
    activosFijos: { none: {} },
    ...(onlyCompanyId ? { companyId: onlyCompanyId } : {}),
  };

  let lastId: string | undefined;
  let scanned = 0;
  let creados = 0;

  while (Date.now() - startedAt < TIME_BUDGET_MS) {
    const page = await prisma.invoice.findMany({
      where: { ...where, ...(lastId ? { id: { gt: lastId } } : {}) },
      select: {
        id: true, companyId: true, tipo: true, usoCfdi: true, subtotal: true, fecha: true,
        items: { select: { claveProdServ: true, importe: true, descripcion: true } },
      },
      orderBy: { id: "asc" },
      take: PAGE,
    });
    if (page.length === 0) break;

    for (const inv of page) {
      scanned++;
      const id = await crearActivoDesdeCfdiSiAplica(prisma, {
        companyId: inv.companyId,
        invoiceId: inv.id,
        subtotal: inv.subtotal,
        fecha: inv.fecha,
        descripcion: inv.items[0]?.descripcion,
        clasifInput: {
          tipo: inv.tipo,
          usoCfdi: inv.usoCfdi ?? null,
          items: inv.items.map((it) => ({ claveProdServ: it.claveProdServ, importe: it.importe })),
        },
      });
      if (id) creados++;
    }

    lastId = page[page.length - 1].id;
    if (page.length < PAGE) break;
  }

  const remaining = await prisma.invoice.count({ where });
  const summary = { ok: true, scanned, creados, remaining, elapsedMs: Date.now() - startedAt };
  console.log("[cron/activos-backfill] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return withCronLock("cron:activos-backfill", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:activos-backfill", () => handle(req));
}
