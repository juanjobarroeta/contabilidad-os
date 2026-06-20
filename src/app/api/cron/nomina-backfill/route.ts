import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseCfdiXml } from "@/lib/sat-fiel";

// ─────────────────────────────────────────────────────────────────────────────
// POST (or GET) /api/cron/nomina-backfill
//
// Rellena los datos del complemento de nómina (regimenNomina, tipoNomina,
// isrRetenidoNomina) de los CFDIs tipo NOMINA ya importados, re-parseando el
// rawXml que se guardó al sincronizar. Necesario para reconocer los recibos de
// ASIMILADOS A SALARIOS (régimen 05–11) que se sincronizaron antes de parsear el
// complemento. Sólo toca filas con regimenNomina = null y rawXml presente; es
// seguro de re-ejecutar.
//
// Auth: CRON_SECRET (Bearer o x-cron-secret), igual que los otros crons.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PAGE = 300;
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

  // Nómina ya importada, sin régimen y con XML para re-parsear.
  const where = {
    tipo: "NOMINA" as const,
    regimenNomina: null,
    rawXml: { not: null },
    ...(onlyCompanyId ? { companyId: onlyCompanyId } : {}),
  };

  let lastId: string | undefined;
  let scanned = 0;
  let updated = 0;
  let asimilados = 0;
  const porRegimen: Record<string, number> = {};

  while (Date.now() - startedAt < TIME_BUDGET_MS) {
    const page = await prisma.invoice.findMany({
      where: { ...where, ...(lastId ? { id: { gt: lastId } } : {}) },
      select: { id: true, rawXml: true },
      orderBy: { id: "asc" },
      take: PAGE,
    });
    if (page.length === 0) break;

    for (const inv of page) {
      scanned++;
      if (!inv.rawXml) continue;
      let parsed;
      try {
        parsed = parseCfdiXml(inv.rawXml);
      } catch {
        continue; // XML ilegible → lo dejamos para revisión manual
      }
      const n = parsed.nomina;
      if (!n?.tipoRegimen) continue; // sin complemento de nómina legible
      await prisma.invoice.update({
        where: { id: inv.id },
        data: {
          regimenNomina: n.tipoRegimen,
          tipoNomina: n.tipoNomina ?? null,
          isrRetenidoNomina: n.isrRetenido ?? null,
        },
      });
      updated++;
      porRegimen[n.tipoRegimen] = (porRegimen[n.tipoRegimen] ?? 0) + 1;
      if (["05", "06", "07", "08", "09", "10", "11"].includes(n.tipoRegimen)) asimilados++;
    }

    lastId = page[page.length - 1].id;
    if (page.length < PAGE) break;
  }

  const remaining = await prisma.invoice.count({ where });

  const summary = {
    ok: true,
    scanned,
    updated,
    asimilados,
    porRegimen,
    remaining,
    elapsedMs: Date.now() - startedAt,
  };
  console.log("[cron/nomina-backfill] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
